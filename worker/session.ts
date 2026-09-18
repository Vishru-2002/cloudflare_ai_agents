import { DurableObject } from "cloudflare:workers";
import type {
  AnalysisState,
  AnalysisStep,
  ChatMessage,
  CodeArtifact,
  SessionState,
  StreamEvent,
} from "../shared/protocol";
import type { Env } from "./types";
import { languageFromPath } from "./tools/static";
import { runAgentTurn } from "./ai/agent";
import { readBudget } from "./lib/budget";

/** How many prior messages to replay into the model. Older turns cost Neurons with little benefit. */
const HISTORY_WINDOW = 8;
const MAX_ARTIFACT_BYTES = 200_000;
const MAX_ARTIFACTS = 10;

interface MessageRow extends Record<string, SqlStorageValue> {
  id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
}

interface ArtifactRow extends Record<string, SqlStorageValue> {
  path: string;
  language: string;
  content: string;
  bytes: number;
}

/**
 * One Durable Object per debugging session.
 *
 * This is the agent's memory: conversation history, the attached source files
 * and the state of any in-flight analysis, all in the DO's own SQLite storage.
 * SQLite-backed Durable Objects are the variant available on the Workers Free
 * plan, which is why the wrangler migration uses `new_sqlite_classes`.
 *
 * Keeping session memory here rather than in D1 means a chat turn does zero D1
 * reads, and the storage lives in the same thread as the agent that uses it.
 */
export class DebugSession extends DurableObject<Env> {
  private sessionId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id         TEXT PRIMARY KEY,
          role       TEXT NOT NULL,
          content    TEXT NOT NULL,
          tool_calls TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          path     TEXT PRIMARY KEY,
          language TEXT NOT NULL,
          content  TEXT NOT NULL,
          bytes    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  // ---------------------------------------------------------------- internals

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private readArtifacts(): CodeArtifact[] {
    return this.ctx.storage.sql
      .exec<ArtifactRow>("SELECT path, language, content, bytes FROM artifacts ORDER BY path")
      .toArray();
  }

  private readMessages(): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<MessageRow>("SELECT * FROM messages ORDER BY created_at, id")
      .toArray()
      .map((row) => ({
        id: row.id,
        role: row.role as ChatMessage["role"],
        content: row.content,
        toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        createdAt: row.created_at,
      }));
  }

  private writeMessage(message: ChatMessage): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?)",
      message.id,
      message.role,
      message.content,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.createdAt,
    );
  }

  private readAnalysis(): AnalysisState | null {
    const raw = this.getMeta("analysis");
    return raw ? (JSON.parse(raw) as AnalysisState) : null;
  }

  private writeAnalysis(analysis: AnalysisState | null): void {
    if (analysis === null) {
      this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'analysis'");
      return;
    }
    this.setMeta("analysis", JSON.stringify(analysis));
  }

  // --------------------------------------------------------------- RPC surface

  async init(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    if (!this.getMeta("session_id")) this.setMeta("session_id", sessionId);
  }

  async getState(): Promise<Omit<SessionState, "budget">> {
    return {
      sessionId: this.getMeta("session_id") ?? this.sessionId,
      messages: this.readMessages(),
      artifacts: this.readArtifacts().map(({ content: _content, ...rest }) => rest),
      analysis: this.readAnalysis(),
    };
  }

  /** Full artifacts including content — used by the Workflow, not sent to the browser wholesale. */
  async getContext(): Promise<{ artifacts: CodeArtifact[]; errorText: string | null }> {
    return { artifacts: this.readArtifacts(), errorText: this.getMeta("error_text") };
  }

  async addArtifact(path: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const clean = path.trim().replace(/^\/+/, "");
    if (!clean) return { ok: false, error: "A file path is required." };

    const bytes = new TextEncoder().encode(content).length;
    if (bytes > MAX_ARTIFACT_BYTES) {
      return { ok: false, error: `File is ${bytes} bytes; the limit is ${MAX_ARTIFACT_BYTES}.` };
    }

    const existing = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts WHERE path != ?", clean)
      .toArray()[0];
    if ((existing?.n ?? 0) >= MAX_ARTIFACTS) {
      return { ok: false, error: `This session already holds ${MAX_ARTIFACTS} files.` };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO artifacts (path, language, content, bytes) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET language = excluded.language, content = excluded.content, bytes = excluded.bytes`,
      clean,
      languageFromPath(clean),
      content,
      bytes,
    );
    return { ok: true };
  }

  async removeArtifact(path: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM artifacts WHERE path = ?", path);
  }

  async setErrorText(text: string): Promise<void> {
    this.setMeta("error_text", text);
  }

  async reset(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM messages");
    this.ctx.storage.sql.exec("DELETE FROM artifacts");
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key != 'session_id'");
  }

  // ------------------------------------------------------- analysis lifecycle

  async startAnalysis(): Promise<{ ok: boolean; instanceId?: string; error?: string }> {
    const artifacts = this.readArtifacts();
    if (artifacts.length === 0) {
      return { ok: false, error: "Attach at least one source file before running an analysis." };
    }

    const existing = this.readAnalysis();
    if (existing && (existing.status === "running" || existing.status === "awaiting-approval")) {
      return { ok: false, error: "An analysis is already in progress for this session." };
    }

    const sessionId = this.getMeta("session_id") ?? this.sessionId;
    const instance = await this.env.DEBUG_WORKFLOW.create({ params: { sessionId } });

    this.writeAnalysis({
      instanceId: instance.id,
      status: "queued",
      steps: [],
      hypotheses: [],
      proposal: null,
      rootCause: null,
      error: null,
      startedAt: new Date().toISOString(),
    });

    return { ok: true, instanceId: instance.id };
  }

  /** Called by the Workflow as it progresses, so the UI can watch the pipeline live. */
  async patchAnalysis(patch: Partial<AnalysisState>, step?: AnalysisStep): Promise<void> {
    const current = this.readAnalysis();
    if (!current) return;

    const steps = step ? mergeStep(current.steps, step) : current.steps;
    this.writeAnalysis({ ...current, ...patch, steps });
  }

  /** Records the final outcome as a chat message so the conversation stays the single narrative. */
  async completeAnalysis(summary: string): Promise<void> {
    this.writeMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      content: summary,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Applies an approved patch to the stored artifact. This is the only path
   * that mutates source, and it runs only after the Workflow has received an
   * explicit approval event from the user.
   */
  async applyApprovedPatch(path: string, newContent: string): Promise<{ ok: boolean; error?: string }> {
    const existing = this.ctx.storage.sql
      .exec<ArtifactRow>("SELECT path, language, content, bytes FROM artifacts WHERE path = ?", path)
      .toArray()[0];
    if (!existing) return { ok: false, error: `No attached file at ${path}.` };

    this.ctx.storage.sql.exec(
      "UPDATE artifacts SET content = ?, bytes = ? WHERE path = ?",
      newContent,
      new TextEncoder().encode(newContent).length,
      path,
    );
    return { ok: true };
  }

  // -------------------------------------------------------------- chat stream

  /**
   * SSE endpoint for a chat turn. Tool activity is emitted as it happens so the
   * UI shows the investigation unfolding, then the final message is sent once.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/chat" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const body = (await request.json()) as { message?: string; model?: string };
    const userMessage = (body.message ?? "").trim();
    if (!userMessage) return new Response("A message is required.", { status: 400 });

    const now = new Date().toISOString();
    const userRecord: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: userMessage,
      createdAt: now,
    };
    this.writeMessage(userRecord);

    const history = this.readMessages().slice(-HISTORY_WINDOW - 1, -1);
    const artifacts = this.readArtifacts();
    const errorText = this.getMeta("error_text");

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const send = async (event: StreamEvent) => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    // Run the turn in the background; the response streams as it goes.
    this.ctx.waitUntil(
      (async () => {
        try {
          await send({ type: "message", message: userRecord });

          const result = await runAgentTurn(
            this.env,
            { artifacts, errorText, history, userMessage, modelId: body.model },
            (event) => send(event as StreamEvent),
          );

          const assistantRecord: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: result.text,
            toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
            createdAt: new Date().toISOString(),
          };
          this.writeMessage(assistantRecord);

          await send({ type: "message", message: assistantRecord });
          await send({ type: "budget", budget: await readBudget(this.env) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await send({ type: "error", message });
        } finally {
          await send({ type: "done" });
          await writer.close();
        }
      })(),
    );

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }
}

function mergeStep(steps: AnalysisStep[], incoming: AnalysisStep): AnalysisStep[] {
  const index = steps.findIndex((s) => s.name === incoming.name);
  if (index === -1) return [...steps, incoming];
  const next = [...steps];
  next[index] = incoming;
  return next;
}
