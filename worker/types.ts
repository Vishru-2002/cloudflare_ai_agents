import type { DebugSession } from "./session";
import type { DebugWorkflowParams } from "./workflow";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  DEBUG_SESSION: DurableObjectNamespace<DebugSession>;
  DEBUG_WORKFLOW: Workflow<DebugWorkflowParams>;
  DB: D1Database;

  MODEL_REASONING: string;
  MODEL_CHEAP: string;
  DAILY_NEURON_BUDGET: string;
  MAX_TOOL_ITERATIONS: string;

  /**
   * Optional local-development escape hatch.
   *
   * The `AI` binding only works when Wrangler can open a remote proxy session,
   * which needs a registered workers.dev subdomain. Setting these two in
   * `.dev.vars` instead makes the app call the Workers AI REST API directly, so
   * `wrangler dev --local` works on a bare account. Unset in production, where
   * the binding is used.
   */
  CF_ACCOUNT_ID?: string;
  CF_AI_TOKEN?: string;
}

/** Message shape accepted by Workers AI chat models. */
export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on tool-result messages so the model can match them to its call. */
  name?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
