import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ModelInfo, ToolCallRecord } from "@shared/protocol";
import Message from "./Message";

interface Props {
  messages: ChatMessage[];
  liveTools: ToolCallRecord[];
  thinking: boolean;
  error: string | null;
  models: ModelInfo[];
  model: string;
  onModelChange: (model: string) => void;
  onSend: (message: string) => Promise<void>;
}

const SUGGESTIONS = [
  "What is causing this error?",
  "Walk me through the failing code path.",
  "Are there other bugs in this file?",
];

export default function ChatPanel({
  messages,
  liveTools,
  thinking,
  error,
  models,
  model,
  onModelChange,
  onSend,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, liveTools.length, thinking]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || thinking) return;
    setDraft("");
    await onSend(message);
  }

  const active = models.find((m) => m.id === model);

  return (
    <main className="panel panel-center">
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !thinking && (
          <div className="empty">
            <h2>AI Debugging Agent</h2>
            <p>
              Attach the code and the error, then ask. The agent reads your source with
              analysis tools before it answers — it does not execute anything.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}

        {thinking && (
          <article className="msg msg-agent">
            <div className="msg-role">Agent</div>
            <div className="msg-body">
              {liveTools.length > 0 && (
                <div className="tool-list">
                  {liveTools.map((call, i) => (
                    <div key={i} className={`tool-card ${call.ok ? "" : "tool-failed"}`}>
                      <div className="tool-head static">
                        <span className="tool-name">{call.name}</span>
                        <span className="tool-args">
                          {call.durationMs >= 0 ? `${call.durationMs}ms` : "running…"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          </article>
        )}

        {error && <p className="inline-error">{error}</p>}
      </div>

      <div className="composer">
        <select
          className="model-select"
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          title={active?.notes}
        >
          {models
            .filter((m) => m.supportsTools)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </select>

        <textarea
          className="composer-input"
          rows={2}
          placeholder="Ask about the bug…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <button className="primary-btn" onClick={() => send(draft)} disabled={thinking || !draft.trim()}>
          Send
        </button>
      </div>
    </main>
  );
}
