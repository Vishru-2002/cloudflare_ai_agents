-- D1 schema for the AI Debugging Agent.
-- D1 holds cross-session data: the Neuron ledger and a history of completed
-- analyses. Per-session conversation memory lives in the Durable Object's own
-- SQLite storage instead, so a chat turn never touches D1.

-- Daily Workers AI spend, used to stay inside the 10,000 Neuron/day free tier.
CREATE TABLE IF NOT EXISTS neuron_usage (
  day           TEXT PRIMARY KEY,   -- UTC date, YYYY-MM-DD
  neurons       REAL NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

-- One row per completed deep-analysis Workflow run.
CREATE TABLE IF NOT EXISTS analyses (
  id            TEXT PRIMARY KEY,   -- workflow instance id
  session_id    TEXT NOT NULL,
  language      TEXT,
  error_message TEXT,
  root_cause    TEXT,
  patch         TEXT,
  approved      INTEGER NOT NULL DEFAULT 0,
  neurons       REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analyses_session ON analyses (session_id, created_at DESC);
