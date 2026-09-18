import { useRef, useState } from "react";
import type { CodeArtifact } from "@shared/protocol";
import { SAMPLES, type Sample } from "../samples";

interface Props {
  artifacts: Array<Omit<CodeArtifact, "content">>;
  errorText: string;
  busy: boolean;
  onAddFile: (path: string, content: string) => Promise<void>;
  onDeleteFile: (path: string) => Promise<void>;
  onErrorTextChange: (text: string) => void;
  onLoadSample: (sample: Sample) => Promise<void>;
  onReset: () => Promise<void>;
}

export default function FilePanel({
  artifacts,
  errorText,
  busy,
  onAddFile,
  onDeleteFile,
  onErrorTextChange,
  onLoadSample,
  onReset,
}: Props) {
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!path.trim() || !content.trim()) {
      setError("A path and some source are both required.");
      return;
    }
    setError(null);
    try {
      await onAddFile(path.trim(), content);
      setPath("");
      setContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files).slice(0, 5)) {
      try {
        await onAddFile(file.name, await file.text());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <aside className="panel panel-left">
      <header className="panel-head">
        <h2>Source</h2>
        <button className="link-btn" onClick={onReset} disabled={busy}>
          Clear session
        </button>
      </header>

      <div className="samples">
        <span className="samples-label">Try a sample:</span>
        {SAMPLES.map((sample) => (
          <button
            key={sample.path}
            className="chip"
            disabled={busy}
            onClick={() => onLoadSample(sample)}
          >
            {sample.label}
          </button>
        ))}
      </div>

      {artifacts.length > 0 && (
        <ul className="file-list">
          {artifacts.map((artifact) => (
            <li key={artifact.path}>
              <div className="file-info">
                <span className="file-path">{artifact.path}</span>
                <span className="file-meta">
                  {artifact.language} · {(artifact.bytes / 1024).toFixed(1)} KB
                </span>
              </div>
              <button
                className="icon-btn"
                title={`Remove ${artifact.path}`}
                onClick={() => onDeleteFile(artifact.path)}
                disabled={busy}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <details className="adder" open={artifacts.length === 0}>
        <summary>Add a file</summary>

        <input
          ref={fileInput}
          type="file"
          multiple
          className="file-input"
          onChange={(e) => handleUpload(e.target.files)}
        />

        <div className="or">or paste</div>

        <input
          className="text-input"
          placeholder="path, e.g. src/cart.js"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <textarea
          className="code-input"
          placeholder="Paste the source here…"
          rows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <button className="primary-btn" onClick={submit} disabled={busy}>
          Attach file
        </button>
      </details>

      <div className="error-box">
        <label htmlFor="error-text">Error output / stack trace</label>
        <textarea
          id="error-text"
          className="code-input"
          rows={7}
          placeholder="Paste the stack trace or error message…"
          value={errorText}
          onChange={(e) => onErrorTextChange(e.target.value)}
        />
      </div>

      {error && <p className="inline-error">{error}</p>}
    </aside>
  );
}
