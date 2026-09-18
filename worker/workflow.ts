import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { AnalysisStep, Hypothesis, PatchProposal } from "../shared/protocol";
import type { Env } from "./types";
import { chat, extractJson } from "./ai/client";
import { HYPOTHESIS_PROMPT, PATCH_PROMPT, renderArtifacts, renderErrorContext } from "./ai/prompts";
import { resolveModel } from "./ai/models";
import { analyzeSource, normalizeLanguage } from "./tools/static";
import { culpritFrame, parseStackTrace } from "./tools/stacktrace";
import { unifiedDiff } from "./tools/diff";
import { assertBudgetAvailable } from "./lib/budget";

export interface DebugWorkflowParams {
  sessionId: string;
}

const APPROVAL_EVENT = "patch-decision";
const APPROVAL_TIMEOUT = "1 hour";

interface ApprovalDecision {
  approved: boolean;
}

/**
 * The deep-analysis pipeline.
 *
 * Why a Workflow rather than a long request handler:
 *  - Each `step.do` result is checkpointed. If the patch step fails and retries,
 *    the expensive hypothesis call is *not* re-run — it replays from storage.
 *    On a 10,000 Neuron/day budget that is the difference between a retry
 *    costing nothing and costing a third of the daily allowance.
 *  - `step.waitForEvent` lets the run pause for human approval for up to an
 *    hour without holding a request open or consuming a concurrency slot.
 *  - Workers request wall-clock limits don't apply across steps.
 */
export class DebugWorkflow extends WorkflowEntrypoint<Env, DebugWorkflowParams> {
  private session(sessionId: string) {
    return this.env.DEBUG_SESSION.get(this.env.DEBUG_SESSION.idFromName(sessionId));
  }

  private async mark(sessionId: string, step: AnalysisStep, patch: Record<string, unknown> = {}) {
    await this.session(sessionId).patchAnalysis(patch as never, step);
  }

  async run(event: WorkflowEvent<DebugWorkflowParams>, step: WorkflowStep) {
    const { sessionId } = event.payload;
    const stub = this.session(sessionId);
    const now = () => new Date().toISOString();

    try {
      await this.mark(sessionId, { name: "Load context", status: "running", at: now() }, { status: "running" });

      // 1. Pull the attached source and error text out of Durable Object memory.
      const context = await step.do("load-context", async () => {
        const loaded = await stub.getContext();
        if (loaded.artifacts.length === 0) throw new Error("No source files attached to this session.");
        return loaded;
      });

      await this.mark(sessionId, {
        name: "Load context",
        status: "done",
        detail: `${context.artifacts.length} file(s)`,
        at: now(),
      });

      // 2. Deterministic analysis. No AI, no Neurons — cheap evidence that makes
      //    the subsequent model calls shorter and better grounded.
      await this.mark(sessionId, { name: "Static analysis", status: "running", at: now() });

      const statics = await step.do("static-analysis", async () => {
        const perFile = context.artifacts.map((a) => ({
          path: a.path,
          findings: analyzeSource(a.content, normalizeLanguage(a.language)),
        }));
        const trace = context.errorText ? parseStackTrace(context.errorText) : null;
        return {
          perFile,
          totalFindings: perFile.reduce((n, f) => n + f.findings.length, 0),
          trace: trace
            ? {
                language: trace.language,
                errorType: trace.errorType,
                errorMessage: trace.errorMessage,
                culprit: culpritFrame(trace),
              }
            : null,
        };
      });

      await this.mark(sessionId, {
        name: "Static analysis",
        status: "done",
        detail: `${statics.totalFindings} finding(s)`,
        at: now(),
      });

      // 3. Rank probable root causes.
      await this.mark(sessionId, { name: "Generate hypotheses", status: "running", at: now() });

      const hypotheses = await step.do(
        "hypothesize",
        { retries: { limit: 1, delay: "3 seconds", backoff: "constant" }, timeout: "2 minutes" },
        async () => {
          await assertBudgetAvailable(this.env);
          const model = resolveModel(undefined, this.env.MODEL_REASONING);

          const result = await chat(this.env, {
            model,
            messages: [
              { role: "system", content: HYPOTHESIS_PROMPT },
              {
                role: "user",
                content: [
                  renderArtifacts(context.artifacts, 5000),
                  "",
                  renderErrorContext(context.errorText),
                  "",
                  "### Static analysis findings",
                  JSON.stringify(statics.perFile).slice(0, 2500),
                  statics.trace ? `\n### Parsed trace\n${JSON.stringify(statics.trace)}` : "",
                ].join("\n"),
              },
            ],
            maxTokens: 700,
            temperature: 0.1,
          });

          const parsed = extractJson<{ hypotheses: Hypothesis[] }>(result.text);
          const list = Array.isArray(parsed?.hypotheses) ? parsed!.hypotheses.slice(0, 3) : [];
          if (list.length === 0) {
            return {
              hypotheses: [
                {
                  summary: "The model did not return a structured hypothesis.",
                  confidence: 0,
                  evidence: result.text.slice(0, 300) || "No output.",
                } as Hypothesis,
              ],
            };
          }
          return { hypotheses: list };
        },
      );

      await this.mark(
        sessionId,
        {
          name: "Generate hypotheses",
          status: "done",
          detail: `${hypotheses.hypotheses.length} candidate cause(s)`,
          at: now(),
        },
        { hypotheses: hypotheses.hypotheses },
      );

      // 4. Draft a minimal patch for the leading hypothesis.
      await this.mark(sessionId, { name: "Draft patch", status: "running", at: now() });

      const proposal = await step.do(
        "draft-patch",
        { retries: { limit: 1, delay: "3 seconds", backoff: "constant" }, timeout: "3 minutes" },
        async () => {
          await assertBudgetAvailable(this.env);
          const model = resolveModel(undefined, this.env.MODEL_REASONING);
          const lead = hypotheses.hypotheses[0];

          const result = await chat(this.env, {
            model,
            messages: [
              { role: "system", content: PATCH_PROMPT },
              {
                role: "user",
                content: [
                  `Leading hypothesis: ${lead?.summary ?? "unknown"}`,
                  `Evidence: ${lead?.evidence ?? "none"}`,
                  "",
                  renderArtifacts(context.artifacts, 6000),
                  "",
                  renderErrorContext(context.errorText),
                ].join("\n"),
              },
            ],
            maxTokens: 2000,
            temperature: 0.1,
          });

          const parsed = extractJson<{
            path: string;
            explanation: string;
            risk: string;
            new_content: string;
          }>(result.text);

          if (!parsed?.new_content || !parsed?.path) {
            return { proposal: null as PatchProposal | null, newContent: null as string | null };
          }

          const target =
            context.artifacts.find((a) => a.path === parsed.path) ??
            context.artifacts.find((a) => a.path.endsWith(parsed.path)) ??
            context.artifacts[0];

          // The model returns full corrected content; we compute the diff so the
          // hunk headers and line numbers shown to the user are always correct.
          const diff = unifiedDiff(target.path, target.content, parsed.new_content);
          if (!diff) return { proposal: null, newContent: null };

          const risk = ["low", "medium", "high"].includes(parsed.risk) ? parsed.risk : "medium";

          return {
            proposal: {
              path: target.path,
              explanation: parsed.explanation || "No explanation supplied.",
              diff,
              risk,
            } as PatchProposal,
            newContent: parsed.new_content,
          };
        },
      );

      if (!proposal.proposal) {
        await this.mark(
          sessionId,
          { name: "Draft patch", status: "failed", detail: "No concrete patch produced", at: now() },
          { status: "complete", rootCause: hypotheses.hypotheses[0]?.summary ?? null },
        );
        await stub.completeAnalysis(
          buildSummary(hypotheses.hypotheses, null, "no-patch"),
        );
        return { status: "complete", patched: false };
      }

      await this.mark(sessionId, { name: "Draft patch", status: "done", detail: proposal.proposal.path, at: now() });

      // 5. Human approval gate. Nothing is written until a person says yes.
      await this.mark(
        sessionId,
        { name: "Await approval", status: "running", at: now() },
        { status: "awaiting-approval", proposal: proposal.proposal, rootCause: hypotheses.hypotheses[0]?.summary ?? null },
      );

      let approved = false;
      try {
        const decision = await step.waitForEvent<ApprovalDecision>("await human approval", {
          type: APPROVAL_EVENT,
          timeout: APPROVAL_TIMEOUT,
        });
        approved = Boolean(decision.payload?.approved);
      } catch {
        // Timed out waiting for a decision — treat as "not approved" and leave
        // the source untouched.
        approved = false;
      }

      await this.mark(sessionId, {
        name: "Await approval",
        status: "done",
        detail: approved ? "Approved" : "Rejected or timed out",
        at: now(),
      });

      // 6. Apply only on approval.
      if (approved) {
        await this.mark(sessionId, { name: "Apply patch", status: "running", at: now() });
        await step.do("apply-patch", async () => {
          const applied = await stub.applyApprovedPatch(proposal.proposal!.path, proposal.newContent!);
          if (!applied.ok) throw new Error(applied.error ?? "Failed to apply patch.");
          return { applied: true };
        });
        await this.mark(sessionId, { name: "Apply patch", status: "done", at: now() });
      }

      // 7. Persist the run to D1 and write the narrative back into the chat.
      await step.do("record", async () => {
        try {
          await this.env.DB.prepare(
            `INSERT INTO analyses (id, session_id, language, error_message, root_cause, patch, approved, neurons, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              event.instanceId,
              sessionId,
              context.artifacts[0]?.language ?? null,
              statics.trace?.errorMessage ?? null,
              hypotheses.hypotheses[0]?.summary ?? null,
              proposal.proposal!.diff,
              approved ? 1 : 0,
              0,
              now(),
            )
            .run();
        } catch {
          // History is a nice-to-have; never fail the run over it.
        }
        return { recorded: true };
      });

      await stub.completeAnalysis(
        buildSummary(hypotheses.hypotheses, proposal.proposal, approved ? "applied" : "rejected"),
      );

      await this.mark(sessionId, { name: "Record", status: "done", at: now() }, {
        status: approved ? "complete" : "rejected",
      });

      return { status: approved ? "complete" : "rejected", patched: approved };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.mark(
        sessionId,
        { name: "Failed", status: "failed", detail: message, at: new Date().toISOString() },
        { status: "errored", error: message },
      );
      throw err;
    }
  }
}

function buildSummary(
  hypotheses: Hypothesis[],
  proposal: PatchProposal | null,
  outcome: "applied" | "rejected" | "no-patch",
): string {
  const lines: string[] = ["**Deep analysis complete.**", ""];

  if (hypotheses.length > 0) {
    lines.push("Most likely root cause:", "", `> ${hypotheses[0].summary}`, "");
    if (hypotheses[0].evidence) lines.push(`Evidence: ${hypotheses[0].evidence}`, "");
    if (hypotheses.length > 1) {
      lines.push("Also considered:");
      for (const h of hypotheses.slice(1)) {
        lines.push(`- ${h.summary} (confidence ${(h.confidence * 100).toFixed(0)}%)`);
      }
      lines.push("");
    }
  }

  if (outcome === "applied" && proposal) {
    lines.push(`Patch approved and applied to \`${proposal.path}\`.`, "", proposal.explanation);
  } else if (outcome === "rejected" && proposal) {
    lines.push(
      `A patch for \`${proposal.path}\` was proposed but not applied — the attached source is unchanged.`,
    );
  } else {
    lines.push(
      "No safe patch could be drafted from the available code. The analysis above is still the best available explanation.",
    );
  }

  return lines.join("\n");
}
