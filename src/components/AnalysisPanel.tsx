import type { AnalysisState } from "@shared/protocol";
import Diff from "./Diff";

interface Props {
  analysis: AnalysisState | null;
  busy: boolean;
  canAnalyze: boolean;
  onStart: () => Promise<void>;
  onDecide: (approved: boolean) => Promise<void>;
}

const STATUS_LABEL: Record<AnalysisState["status"], string> = {
  queued: "Queued",
  running: "Running",
  "awaiting-approval": "Waiting for your approval",
  complete: "Complete",
  rejected: "Patch rejected",
  errored: "Failed",
};

export default function AnalysisPanel({ analysis, busy, canAnalyze, onStart, onDecide }: Props) {
  const awaiting = analysis?.status === "awaiting-approval";

  return (
    <aside className="panel panel-right">
      <header className="panel-head">
        <h2>Deep analysis</h2>
        {analysis && <span className={`status status-${analysis.status}`}>{STATUS_LABEL[analysis.status]}</span>}
      </header>

      <p className="panel-blurb">
        Runs a durable Cloudflare Workflow: static analysis → hypotheses → patch → your approval.
        Nothing is written to your source until you approve it.
      </p>

      <button className="primary-btn wide" onClick={onStart} disabled={busy || !canAnalyze}>
        {busy ? "Working…" : "Analyze & Fix"}
      </button>
      {!canAnalyze && <p className="hint">Attach at least one source file first.</p>}

      {analysis && (
        <>
          <ol className="steps">
            {analysis.steps.map((step) => (
              <li key={step.name} className={`step step-${step.status}`}>
                <span className="step-dot" />
                <div>
                  <span className="step-name">{step.name}</span>
                  {step.detail && <span className="step-detail">{step.detail}</span>}
                </div>
              </li>
            ))}
          </ol>

          {analysis.hypotheses.length > 0 && (
            <section className="hypotheses">
              <h3>Candidate root causes</h3>
              {analysis.hypotheses.map((h, i) => (
                <div key={i} className="hypothesis">
                  <div className="hyp-head">
                    <span className="hyp-rank">{i + 1}</span>
                    <span className="hyp-confidence">{(h.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <p className="hyp-summary">{h.summary}</p>
                  {h.location && <code className="hyp-location">{h.location}</code>}
                  {h.evidence && <p className="hyp-evidence">{h.evidence}</p>}
                </div>
              ))}
            </section>
          )}

          {analysis.proposal && (
            <section className="proposal">
              <h3>
                Proposed patch
                <span className={`risk risk-${analysis.proposal.risk}`}>
                  {analysis.proposal.risk} risk
                </span>
              </h3>
              <p className="proposal-path">{analysis.proposal.path}</p>
              <p className="proposal-why">{analysis.proposal.explanation}</p>
              <Diff diff={analysis.proposal.diff} />

              {awaiting && (
                <div className="approval">
                  <p className="approval-prompt">
                    Apply this patch to the attached file? The agent will not modify anything
                    unless you approve.
                  </p>
                  <div className="approval-actions">
                    <button className="approve-btn" onClick={() => onDecide(true)} disabled={busy}>
                      Approve &amp; apply
                    </button>
                    <button className="reject-btn" onClick={() => onDecide(false)} disabled={busy}>
                      Reject
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {analysis.error && <p className="inline-error">{analysis.error}</p>}
        </>
      )}
    </aside>
  );
}
