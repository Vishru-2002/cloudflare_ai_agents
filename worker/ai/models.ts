import type { ModelInfo } from "../../shared/protocol";

/**
 * Workers AI models this app is allowed to use.
 *
 * Every model here is usable on the Workers **Free** plan. Cloudflare gates a
 * handful of large models behind a paid billing method (the DeepSeek v4,
 * GLM 5.x and Kimi K2 families at time of writing) — those are deliberately
 * absent so a free-plan account never hits a billing error.
 *
 * Neuron rates are Cloudflare's published per-1M-token prices and drive the
 * budget meter in the UI. They are estimates for display and throttling, not
 * billing; Cloudflare's own dashboard remains the source of truth.
 */
export const MODELS: Record<string, ModelInfo> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B (fp8, fast)",
    supportsTools: true,
    inputNeuronsPerMTok: 26_668,
    outputNeuronsPerMTok: 204_805,
    notes: "Best reasoning. Output is ~7x the Neuron cost of gpt-oss-20b — use for the final patch.",
  },
  "@cf/openai/gpt-oss-20b": {
    id: "@cf/openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    supportsTools: true,
    inputNeuronsPerMTok: 18_182,
    outputNeuronsPerMTok: 27_273,
    notes: "Supports tool calling at a fraction of the output cost. Best value for the agent loop.",
  },
  "@cf/meta/llama-3.1-8b-instruct-fp8": {
    id: "@cf/meta/llama-3.1-8b-instruct-fp8",
    label: "Llama 3.1 8B (fp8)",
    supportsTools: false,
    inputNeuronsPerMTok: 13_778,
    outputNeuronsPerMTok: 26_128,
    notes: "No tool calling. Used for cheap classification and summarisation steps.",
  },
};

export const DEFAULT_REASONING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const DEFAULT_CHEAP_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** Cloudflare's included daily allowance on both Free and Paid plans. */
export const FREE_TIER_DAILY_NEURONS = 10_000;

export function resolveModel(requested: string | undefined, fallback: string): ModelInfo {
  if (requested && MODELS[requested]) return MODELS[requested];
  return MODELS[fallback] ?? MODELS[DEFAULT_REASONING_MODEL];
}

/** Pick a tool-capable model, falling back if the configured one can't call tools. */
export function resolveToolModel(requested: string | undefined, fallback: string): ModelInfo {
  const model = resolveModel(requested, fallback);
  if (model.supportsTools) return model;
  return MODELS[DEFAULT_REASONING_MODEL];
}

export function estimateNeurons(model: ModelInfo, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * model.inputNeuronsPerMTok +
    (outputTokens / 1_000_000) * model.outputNeuronsPerMTok
  );
}

/**
 * Rough token estimate used only when Workers AI does not return a usage block.
 * ~4 characters per token is the usual English/code approximation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function listModels(): ModelInfo[] {
  return Object.values(MODELS);
}
