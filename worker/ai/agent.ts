import type { ChatMessage, CodeArtifact, ToolArgs, ToolCallRecord } from "../../shared/protocol";
import type { AiMessage, Env } from "../types";
import { chat } from "./client";
import { AGENT_SYSTEM_PROMPT, renderArtifacts, renderErrorContext } from "./prompts";
import { resolveToolModel } from "./models";
import { TOOL_DEFS, runTool, type ToolContext } from "../tools";
import { assertBudgetAvailable } from "../lib/budget";

export interface AgentTurnInput {
  artifacts: CodeArtifact[];
  errorText: string | null;
  /** Prior conversation, oldest first. Already trimmed by the caller. */
  history: ChatMessage[];
  userMessage: string;
  modelId?: string;
}

export interface AgentTurnOutput {
  text: string;
  toolCalls: ToolCallRecord[];
  neurons: number;
}

export type AgentEmitter = (event:
  | { type: "tool-start"; name: string; args: ToolArgs }
  | { type: "tool-end"; name: string; ok: boolean; result: string; durationMs: number },
) => void | Promise<void>;

/**
 * Runs one conversational turn: an investigate-then-answer loop where the model
 * may call read-only analysis tools before committing to an explanation.
 *
 * Cost control matters here — each iteration is a full Workers AI call whose
 * prompt grows by the previous tool result. MAX_TOOL_ITERATIONS caps that, and
 * the final iteration drops the tool definitions so the model has no choice but
 * to answer rather than spending another call on a tool.
 */
export async function runAgentTurn(
  env: Env,
  input: AgentTurnInput,
  emit: AgentEmitter,
): Promise<AgentTurnOutput> {
  await assertBudgetAvailable(env);

  const model = resolveToolModel(input.modelId, env.MODEL_REASONING);
  const maxIterations = Math.max(1, Number(env.MAX_TOOL_ITERATIONS) || 4);

  const ctx: ToolContext = { artifacts: input.artifacts, errorText: input.errorText };

  const messages: AiMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Here is the code and error under investigation.",
        "",
        renderArtifacts(input.artifacts),
        "",
        renderErrorContext(input.errorText),
      ].join("\n"),
    },
    {
      role: "assistant",
      content: "Understood. I have the attached code and error output in view. What would you like me to look into?",
    },
    ...input.history.map<AiMessage>((m) => ({
      role: m.role === "tool" ? "assistant" : m.role,
      content: m.content,
    })),
    { role: "user", content: input.userMessage },
  ];

  const toolCalls: ToolCallRecord[] = [];
  let neurons = 0;
  let text = "";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const isLastIteration = iteration === maxIterations - 1;
    const result = await chat(env, {
      model,
      messages,
      // Withhold tools on the final pass so the loop always terminates in prose.
      tools: isLastIteration ? undefined : TOOL_DEFS,
      maxTokens: 1200,
      temperature: 0.2,
    });

    neurons += result.neurons;

    if (result.toolCalls.length === 0) {
      text = result.text.trim();
      break;
    }

    // Record the model's decision to call tools, then feed results back.
    messages.push({
      role: "assistant",
      content:
        result.text.trim() ||
        `Calling: ${result.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ")}`,
    });

    // Models sometimes emit the same tool call twice in one response. Running it
    // twice appends two identical results, and both are re-sent on every later
    // iteration — so deduplicate before spending anything on it.
    const seen = new Set<string>();
    const pending = result.toolCalls
      .filter((call) => {
        const key = `${call.name}:${JSON.stringify(call.args)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);

    for (const call of pending) {
      await emit({ type: "tool-start", name: call.name, args: call.args });
      const started = Date.now();
      const outcome = await runTool(call.name, call.args, ctx);
      const durationMs = Date.now() - started;

      await emit({
        type: "tool-end",
        name: call.name,
        ok: outcome.ok,
        result: outcome.text,
        durationMs,
      });

      toolCalls.push({
        name: call.name,
        args: call.args,
        result: outcome.text,
        ok: outcome.ok,
        durationMs,
      });

      messages.push({
        role: "tool",
        name: call.name,
        content: outcome.text,
      });
    }
  }

  if (!text) {
    text =
      "I ran out of investigation steps before reaching a conclusion. " +
      "Narrow the question — for example, ask about one specific function or line — and I'll look again.";
  }

  return { text, toolCalls, neurons };
}
