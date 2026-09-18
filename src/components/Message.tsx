import { useState } from "react";
import type { ChatMessage, ToolCallRecord } from "@shared/protocol";
import Markdown from "./Markdown";

function ToolCard({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`tool-card ${call.ok ? "" : "tool-failed"}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-args">
          {Object.entries(call.args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ") || "no arguments"}
        </span>
        <span className="tool-time">{call.durationMs}ms</span>
      </button>
      {open && <pre className="tool-result">{call.result}</pre>}
    </div>
  );
}

export default function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <article className={`msg ${isUser ? "msg-user" : "msg-agent"}`}>
      <div className="msg-role">{isUser ? "You" : "Agent"}</div>
      <div className="msg-body">
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="tool-list">
            {message.toolCalls.map((call, i) => (
              <ToolCard key={`${call.name}-${i}`} call={call} />
            ))}
          </div>
        )}
        {isUser ? <p className="plain">{message.content}</p> : <Markdown text={message.content} />}
      </div>
    </article>
  );
}
