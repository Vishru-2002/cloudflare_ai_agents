import type { ModelInfo, ToolArgs } from "../../shared/protocol";
import type { AiMessage, Env } from "../types";
import { estimateNeurons, estimateTokens } from "./models";
import { recordSpend } from "../lib/budget";

/** A tool definition in the flat shape Workers AI documents. */
export interface AiToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ParsedToolCall {
  name: string;
  args: ToolArgs;
}

export interface ChatResult {
  text: string;
  toolCalls: ParsedToolCall[];
  inputTokens: number;
  outputTokens: number;
  neurons: number;
}

export interface ChatOptions {
  model: ModelInfo;
  messages: AiMessage[];
  tools?: AiToolDef[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * Workers AI returns `tool_calls` in a couple of shapes depending on the model
 * family: the documented flat `{ name, arguments }`, and an OpenAI-compatible
 * `{ function: { name, arguments } }` where arguments is a JSON *string*.
 * Normalise both so callers only ever see ParsedToolCall.
 */
function parseToolCalls(raw: unknown): ParsedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ParsedToolCall[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, any>;
    const fn = candidate.function ?? candidate;
    const name = typeof fn.name === "string" ? fn.name : null;
    if (!name) continue;

    let args: ToolArgs = {};
    const rawArgs = fn.arguments ?? fn.parameters ?? {};
    if (typeof rawArgs === "string") {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object") args = parsed as ToolArgs;
      } catch {
        // Model emitted malformed JSON. Pass an empty object; the tool layer
        // validates arguments and will return a usable error to the model.
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as ToolArgs;
    }

    calls.push({ name, args });
  }

  return calls;
}

function extractText(result: Record<string, any>): string {
  const response = result?.response;
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    // Some models nest the text; fall back to a readable serialisation.
    if (typeof response.text === "string") return response.text;
    return JSON.stringify(response);
  }
  if (typeof result?.result === "string") return result.result;
  return "";
}

/**
 * Invoke a model, preferring the `AI` binding and falling back to the Workers AI
 * REST API when local-dev credentials are configured.
 *
 * The binding is the production path: lower latency, no token to manage. The
 * REST path exists because the binding requires a remote proxy session that a
 * brand-new account cannot open, which would otherwise make the agent
 * impossible to run locally.
 */
async function runModel(
  env: Env,
  modelId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  if (env.CF_ACCOUNT_ID && env.CF_AI_TOKEN) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${modelId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CF_AI_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    const body = (await res.json()) as Record<string, any>;
    if (!res.ok || body?.success === false) {
      const detail =
        body?.errors?.map((e: { message?: string }) => e.message).filter(Boolean).join("; ") ||
        `HTTP ${res.status}`;
      throw new Error(`Workers AI REST call failed: ${detail}`);
    }
    // The REST envelope wraps the model output in `result`.
    return (body.result ?? {}) as Record<string, any>;
  }

  return (await env.AI.run(modelId as any, payload as any)) as Record<string, any>;
}

/**
 * One non-streaming Workers AI call, with Neuron accounting.
 * Spend is recorded even on tool-call turns, because those cost tokens too.
 */
export async function chat(env: Env, opts: ChatOptions): Promise<ChatResult> {
  const { model, messages, tools, maxTokens = 1024, temperature = 0.2 } = opts;

  const payload: Record<string, unknown> = {
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (tools && tools.length > 0) payload.tools = tools;

  const raw = await runModel(env, model.id, payload);

  const text = extractText(raw);
  const toolCalls = parseToolCalls(raw?.tool_calls);

  // Prefer the model's own usage numbers; estimate only when absent.
  const promptChars = messages.map((m) => m.content).join("");
  const inputTokens = Number(raw?.usage?.prompt_tokens) || estimateTokens(promptChars);
  const outputTokens =
    Number(raw?.usage?.completion_tokens) ||
    estimateTokens(text + JSON.stringify(toolCalls));

  // Workers AI reports the actual Neuron cost in `usage.neurons`. Prefer it —
  // the price-table estimate is only a fallback for responses that omit it.
  const reported = Number(raw?.usage?.neurons);
  const neurons =
    Number.isFinite(reported) && reported > 0
      ? reported
      : estimateNeurons(model, inputTokens, outputTokens);

  await recordSpend(env, neurons, inputTokens, outputTokens);

  return { text, toolCalls, inputTokens, outputTokens, neurons };
}

export function extractJson<T>(text: string): T | null {
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Fall through to brace matching.
    }

    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}
