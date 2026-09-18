import type { BudgetState } from "../../shared/protocol";
import { FREE_TIER_DAILY_NEURONS } from "../ai/models";
import type { Env } from "../types";

/**
 * Tracks Workers AI spend against the free plan's 10,000 Neurons/day.
 *
 * The ledger lives in D1 so every session shares one counter — a per-session
 * counter would let ten browser tabs blow through the daily allowance. If D1 is
 * unreachable the app degrades to "unknown spend" and keeps serving rather than
 * failing the request, because the free allowance resets daily anyway.
 */

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function budgetLimit(env: Env): number {
  const parsed = Number(env.DAILY_NEURON_BUDGET);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 9000;
}

export async function readBudget(env: Env): Promise<BudgetState> {
  const day = utcDay();
  const limit = budgetLimit(env);
  let neuronsUsed = 0;
  let calls = 0;

  try {
    const row = await env.DB.prepare(
      "SELECT neurons, calls FROM neuron_usage WHERE day = ?",
    )
      .bind(day)
      .first<{ neurons: number; calls: number }>();
    if (row) {
      neuronsUsed = row.neurons ?? 0;
      calls = row.calls ?? 0;
    }
  } catch {
    // D1 not configured or unavailable — report zero rather than blocking.
  }

  return {
    day,
    neuronsUsed,
    neuronsBudget: limit,
    freeTierDaily: FREE_TIER_DAILY_NEURONS,
    calls,
    exhausted: neuronsUsed >= limit,
  };
}

export async function recordSpend(
  env: Env,
  neurons: number,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const day = utcDay();
  try {
    await env.DB.prepare(
      `INSERT INTO neuron_usage (day, neurons, calls, input_tokens, output_tokens, updated_at)
       VALUES (?1, ?2, 1, ?3, ?4, ?5)
       ON CONFLICT(day) DO UPDATE SET
         neurons       = neurons + ?2,
         calls         = calls + 1,
         input_tokens  = input_tokens + ?3,
         output_tokens = output_tokens + ?4,
         updated_at    = ?5`,
    )
      .bind(day, neurons, inputTokens, outputTokens, new Date().toISOString())
      .run();
  } catch {
    // Non-fatal: losing a ledger write costs accuracy, not correctness.
  }
}

/** Throws if the daily budget is already spent. */
export async function assertBudgetAvailable(env: Env): Promise<BudgetState> {
  const budget = await readBudget(env);
  if (budget.exhausted) {
    throw new Error(
      `Daily Workers AI budget spent: ${budget.neuronsUsed.toFixed(0)} of ` +
        `${budget.neuronsBudget} Neurons used (free plan allows ` +
        `${FREE_TIER_DAILY_NEURONS}/day, resets 00:00 UTC). ` +
        `Switch to a cheaper model or wait for the reset.`,
    );
  }
  return budget;
}
