import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnalysisState,
  BudgetState,
  ChatMessage,
  ModelInfo,
  SessionState,
  ToolCallRecord,
} from "@shared/protocol";
import * as api from "./api";
import type { Sample } from "./samples";
import BudgetMeter from "./components/BudgetMeter";
import FilePanel from "./components/FilePanel";
import ChatPanel from "./components/ChatPanel";
import AnalysisPanel from "./components/AnalysisPanel";

/** Statuses that mean the Workflow is still moving and the UI should keep polling. */
const LIVE_STATUSES: AnalysisState["status"][] = ["queued", "running", "awaiting-approval"];

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveTools, setLiveTools] = useState<ToolCallRecord[]>([]);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [errorText, setErrorTextLocal] = useState("");
  const errorSaveTimer = useRef<number | null>(null);

  // ------------------------------------------------------------------ bootstrap

  useEffect(() => {
    (async () => {
      try {
        const [id, modelList] = await Promise.all([api.getOrCreateSession(), api.fetchModels()]);
        setSessionId(id);
        setModels(modelList.models);
        setModel(modelList.reasoning);

        const initial = await api.fetchState(id);
        setState(initial);
        setMessages(initial.messages);
        setBudget(initial.budget);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const refreshState = useCallback(async () => {
    if (!sessionId) return;
    const next = await api.fetchState(sessionId);
    setState(next);
    setMessages(next.messages);
    setBudget(next.budget);
  }, [sessionId]);

  // ----------------------------------------------------------- analysis polling

  useEffect(() => {
    const status = state?.analysis?.status;
    if (!sessionId || !status || !LIVE_STATUSES.includes(status)) return;

    const timer = window.setInterval(async () => {
      try {
        const { analysis } = await api.fetchAnalysis(sessionId);
        setState((prev) => (prev ? { ...prev, analysis } : prev));

        // A finished run appends its summary to the conversation.
        if (analysis && !LIVE_STATUSES.includes(analysis.status)) {
          await refreshState();
        }
      } catch {
        // Transient failure; the next tick retries.
      }
    }, 1500);

    return () => window.clearInterval(timer);
  }, [sessionId, state?.analysis?.status, refreshState]);

  // ---------------------------------------------------------------- interactions

  async function handleSend(message: string) {
    if (!sessionId) return;
    setError(null);
    setThinking(true);
    setLiveTools([]);

    try {
      await api.streamChat(sessionId, message, model, (event) => {
        switch (event.type) {
          case "message":
            setMessages((prev) =>
              prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message],
            );
            // The final assistant message carries its own tool cards.
            if (event.message.role === "assistant") setLiveTools([]);
            break;
          case "tool-start":
            setLiveTools((prev) => [
              ...prev,
              { name: event.name, args: event.args, result: "", ok: true, durationMs: -1 },
            ]);
            break;
          case "tool-end":
            setLiveTools((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].name === event.name && next[i].durationMs === -1) {
                  next[i] = { ...next[i], ok: event.ok, result: event.result, durationMs: event.durationMs };
                  break;
                }
              }
              return next;
            });
            break;
          case "budget":
            setBudget(event.budget);
            break;
          case "error":
            setError(event.message);
            break;
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
      setLiveTools([]);
    }
  }

  async function handleAddFile(path: string, content: string) {
    if (!sessionId) return;
    await api.uploadFile(sessionId, path, content);
    await refreshState();
  }

  async function handleDeleteFile(path: string) {
    if (!sessionId) return;
    await api.deleteFile(sessionId, path);
    await refreshState();
  }

  /** Error text saves on a debounce so typing a stack trace isn't one request per keystroke. */
  function handleErrorTextChange(text: string) {
    setErrorTextLocal(text);
    if (!sessionId) return;
    if (errorSaveTimer.current) window.clearTimeout(errorSaveTimer.current);
    errorSaveTimer.current = window.setTimeout(() => {
      void api.setErrorText(sessionId, text).catch(() => undefined);
    }, 600);
  }

  async function handleLoadSample(sample: Sample) {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadFile(sessionId, sample.path, sample.content);
      await api.setErrorText(sessionId, sample.error);
      setErrorTextLocal(sample.error);
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.resetSession(sessionId);
      setErrorTextLocal("");
      setMessages([]);
      await refreshState();
    } finally {
      setBusy(false);
    }
  }

  async function handleStartAnalysis() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.startAnalysis(sessionId);
      const { analysis } = await api.fetchAnalysis(sessionId);
      setState((prev) => (prev ? { ...prev, analysis } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDecide(approved: boolean) {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.decidePatch(sessionId, approved);
      const { analysis } = await api.fetchAnalysis(sessionId);
      setState((prev) => (prev ? { ...prev, analysis } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <h1>AI Debugging Agent</h1>
            <p>Workers · Workers AI · Workflows · Durable Objects · D1</p>
          </div>
        </div>
        <BudgetMeter budget={budget} />
      </header>

      <div className="layout">
        <FilePanel
          artifacts={state?.artifacts ?? []}
          errorText={errorText}
          busy={busy}
          onAddFile={handleAddFile}
          onDeleteFile={handleDeleteFile}
          onErrorTextChange={handleErrorTextChange}
          onLoadSample={handleLoadSample}
          onReset={handleReset}
        />

        <ChatPanel
          messages={messages}
          liveTools={liveTools}
          thinking={thinking}
          error={error}
          models={models}
          model={model}
          onModelChange={setModel}
          onSend={handleSend}
        />

        <AnalysisPanel
          analysis={state?.analysis ?? null}
          busy={busy}
          canAnalyze={(state?.artifacts.length ?? 0) > 0}
          onStart={handleStartAnalysis}
          onDecide={handleDecide}
        />
      </div>
    </div>
  );
}
