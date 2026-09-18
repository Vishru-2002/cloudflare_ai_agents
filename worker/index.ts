import { Hono } from "hono";
import type { Env } from "./types";
import { listModels } from "./ai/models";
import { readBudget } from "./lib/budget";

export { DebugSession } from "./session";
export { DebugWorkflow } from "./workflow";

const app = new Hono<{ Bindings: Env }>();

function sessionStub(env: Env, sessionId: string) {
  return env.DEBUG_SESSION.get(env.DEBUG_SESSION.idFromName(sessionId));
}

/** Session ids come from the client, so validate them before using as a DO name. */
function validSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "ai-debug-agent", time: new Date().toISOString() }),
);

app.get("/api/models", (c) => c.json({ models: listModels(), reasoning: c.env.MODEL_REASONING }));

app.get("/api/budget", async (c) => c.json(await readBudget(c.env)));

app.post("/api/session", async (c) => {
  const sessionId = crypto.randomUUID();
  await sessionStub(c.env, sessionId).init(sessionId);
  return c.json({ sessionId });
});

// Every /api/session/:id route shares this guard.
app.use("/api/session/:id/*", async (c, next) => {
  if (!validSessionId(c.req.param("id"))) return c.json({ error: "Invalid session id." }, 400);
  await next();
});

app.get("/api/session/:id", async (c) => {
  const id = c.req.param("id");
  if (!validSessionId(id)) return c.json({ error: "Invalid session id." }, 400);

  const stub = sessionStub(c.env, id);
  await stub.init(id);
  const [state, budget] = await Promise.all([stub.getState(), readBudget(c.env)]);
  return c.json({ ...state, budget });
});

app.post("/api/session/:id/files", async (c) => {
  const body = await c.req.json<{ path?: string; content?: string }>();
  if (!body.path || typeof body.content !== "string") {
    return c.json({ error: "path and content are required." }, 400);
  }

  const result = await sessionStub(c.env, c.req.param("id")).addArtifact(body.path, body.content);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

app.delete("/api/session/:id/files", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query parameter is required." }, 400);
  await sessionStub(c.env, c.req.param("id")).removeArtifact(path);
  return c.json({ ok: true });
});

app.post("/api/session/:id/error", async (c) => {
  const body = await c.req.json<{ text?: string }>();
  await sessionStub(c.env, c.req.param("id")).setErrorText(body.text ?? "");
  return c.json({ ok: true });
});

app.post("/api/session/:id/reset", async (c) => {
  await sessionStub(c.env, c.req.param("id")).reset();
  return c.json({ ok: true });
});

/**
 * Chat is proxied straight through to the Durable Object, which owns the
 * conversation and returns a server-sent event stream.
 */
app.post("/api/session/:id/chat", async (c) => {
  const stub = sessionStub(c.env, c.req.param("id"));
  const body = await c.req.text();

  return stub.fetch(
    new Request("https://session/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
});

app.post("/api/session/:id/analyze", async (c) => {
  const result = await sessionStub(c.env, c.req.param("id")).startAnalysis();
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, instanceId: result.instanceId });
});

app.get("/api/session/:id/analysis", async (c) => {
  const state = await sessionStub(c.env, c.req.param("id")).getState();
  if (!state.analysis) return c.json({ analysis: null, workflow: null });

  let workflow: unknown = null;
  try {
    const instance = await c.env.DEBUG_WORKFLOW.get(state.analysis.instanceId);
    workflow = await instance.status();
  } catch {
    // Instance may have aged out of the 3-day free-plan retention window.
  }

  return c.json({ analysis: state.analysis, workflow });
});

/** The human approval gate: resumes the paused Workflow with the user's decision. */
app.post("/api/session/:id/analysis/decision", async (c) => {
  const body = await c.req.json<{ approved?: boolean }>();
  const state = await sessionStub(c.env, c.req.param("id")).getState();

  if (!state.analysis) return c.json({ error: "No analysis is running for this session." }, 400);
  if (state.analysis.status !== "awaiting-approval") {
    return c.json({ error: `Analysis is "${state.analysis.status}", not awaiting approval.` }, 409);
  }

  try {
    const instance = await c.env.DEBUG_WORKFLOW.get(state.analysis.instanceId);
    await instance.sendEvent({
      type: "patch-decision",
      payload: { approved: Boolean(body.approved) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Could not deliver the decision: ${message}` }, 500);
  }

  return c.json({ ok: true, approved: Boolean(body.approved) });
});

app.get("/api/history", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, session_id, language, error_message, root_cause, approved, created_at
       FROM analyses ORDER BY created_at DESC LIMIT 20`,
    ).all();
    return c.json({ analyses: results });
  } catch {
    return c.json({ analyses: [], note: "D1 is not configured — run `npm run setup`." });
  }
});

app.onError((err, c) => {
  console.error("Unhandled error", err);
  return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
