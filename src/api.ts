import type {
  AnalysisState,
  BudgetState,
  ModelInfo,
  SessionState,
  StreamEvent,
} from "@shared/protocol";

const SESSION_KEY = "ai-debug-agent.session";

async function json<T>(res: Response): Promise<T> {
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(body.slice(0, 200) || `Request failed (${res.status})`);
  }
  if (!res.ok) {
    const message = (parsed as { error?: string })?.error ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return parsed as T;
}

/** Reuses the session across reloads so the Durable Object's memory persists. */
export async function getOrCreateSession(): Promise<string> {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) return stored;

  const { sessionId } = await json<{ sessionId: string }>(
    await fetch("/api/session", { method: "POST" }),
  );
  localStorage.setItem(SESSION_KEY, sessionId);
  return sessionId;
}

export function forgetSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export async function fetchState(sessionId: string): Promise<SessionState> {
  return json<SessionState>(await fetch(`/api/session/${sessionId}`));
}

export async function fetchModels(): Promise<{ models: ModelInfo[]; reasoning: string }> {
  return json(await fetch("/api/models"));
}

export async function fetchBudget(): Promise<BudgetState> {
  return json<BudgetState>(await fetch("/api/budget"));
}

export async function uploadFile(sessionId: string, path: string, content: string): Promise<void> {
  await json(
    await fetch(`/api/session/${sessionId}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content }),
    }),
  );
}

export async function deleteFile(sessionId: string, path: string): Promise<void> {
  await json(
    await fetch(`/api/session/${sessionId}/files?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  );
}

export async function setErrorText(sessionId: string, text: string): Promise<void> {
  await json(
    await fetch(`/api/session/${sessionId}/error`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
}

export async function resetSession(sessionId: string): Promise<void> {
  await json(await fetch(`/api/session/${sessionId}/reset`, { method: "POST" }));
}

export async function startAnalysis(sessionId: string): Promise<string> {
  const result = await json<{ instanceId: string }>(
    await fetch(`/api/session/${sessionId}/analyze`, { method: "POST" }),
  );
  return result.instanceId;
}

export async function fetchAnalysis(
  sessionId: string,
): Promise<{ analysis: AnalysisState | null; workflow: { status?: string } | null }> {
  return json(await fetch(`/api/session/${sessionId}/analysis`));
}

export async function decidePatch(sessionId: string, approved: boolean): Promise<void> {
  await json(
    await fetch(`/api/session/${sessionId}/analysis/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved }),
    }),
  );
}

/**
 * Posts a chat message and yields server-sent events as they arrive.
 * EventSource can't issue a POST, so the stream is parsed by hand.
 */
export async function streamChat(
  sessionId: string,
  message: string,
  model: string | undefined,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/session/${sessionId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, model }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(await res.text().then((t) => t.slice(0, 200) || "Chat request failed."));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index: number;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (!frame.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(frame.slice(5).trim()) as StreamEvent);
      } catch {
        // Ignore malformed frames rather than killing the stream.
      }
    }
  }
}
