/**
 * Types shared between the Worker and the React app.
 * The web build aliases "@shared/*" to this directory (see web/vite.config.ts),
 * so there is exactly one definition of the wire format.
 */

export type Role = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Present on assistant messages that invoked tools. */
  toolCalls?: ToolCallRecord[];
  createdAt: string;
}

/**
 * Tool arguments as they cross the Durable Object RPC boundary.
 * Workers RPC types reject `unknown`, and every tool this agent exposes takes
 * flat scalar arguments, so the narrow type is also the accurate one.
 */
export type ToolArgs = Record<string, string | number | boolean | null>;

export interface ToolCallRecord {
  name: string;
  args: ToolArgs;
  /** Stringified tool output, truncated for display. */
  result: string;
  ok: boolean;
  durationMs: number;
}

/** A file the user has attached to the session for the agent to reason about. */
export interface CodeArtifact {
  path: string;
  language: string;
  content: string;
  bytes: number;
}

export interface SessionState {
  sessionId: string;
  messages: ChatMessage[];
  artifacts: Array<Omit<CodeArtifact, "content">>;
  /** Most recent deep-analysis run, if any. */
  analysis: AnalysisState | null;
  budget: BudgetState;
}

export type AnalysisStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "complete"
  | "rejected"
  | "errored";

export interface AnalysisState {
  instanceId: string;
  status: AnalysisStatus;
  /** Human-readable step log, appended as the Workflow progresses. */
  steps: AnalysisStep[];
  hypotheses: Hypothesis[];
  /** Populated once the Workflow reaches the approval gate. */
  proposal: PatchProposal | null;
  rootCause: string | null;
  error: string | null;
  startedAt: string;
}

export interface AnalysisStep {
  name: string;
  status: "running" | "done" | "failed";
  detail?: string;
  at: string;
}

export interface Hypothesis {
  summary: string;
  confidence: number; // 0..1
  evidence: string;
  location?: string;
}

/** A patch the agent wants to apply. Always requires explicit human approval. */
export interface PatchProposal {
  path: string;
  explanation: string;
  /** Unified diff. */
  diff: string;
  risk: "low" | "medium" | "high";
}

export interface BudgetState {
  /** UTC day the counters apply to. */
  day: string;
  neuronsUsed: number;
  neuronsBudget: number;
  /** Cloudflare's free daily allowance, for display. */
  freeTierDaily: number;
  calls: number;
  exhausted: boolean;
}

/** Server-sent event payloads streamed during a chat turn. */
export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "tool-start"; name: string; args: ToolArgs }
  | { type: "tool-end"; name: string; ok: boolean; result: string; durationMs: number }
  | { type: "message"; message: ChatMessage }
  | { type: "budget"; budget: BudgetState }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ModelInfo {
  id: string;
  label: string;
  supportsTools: boolean;
  /** Neurons per 1M tokens. */
  inputNeuronsPerMTok: number;
  outputNeuronsPerMTok: number;
  notes: string;
}
