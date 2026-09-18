import type { BudgetState } from "@shared/protocol";

/**
 * Shows Workers AI spend against the free plan's 10,000 Neurons/day.
 * This is the single most useful thing on screen when demonstrating that the
 * app is designed to live inside the free tier.
 */
export default function BudgetMeter({ budget }: { budget: BudgetState | null }) {
  if (!budget) return null;

  const pct = Math.min(100, (budget.neuronsUsed / budget.neuronsBudget) * 100);
  const level = pct > 90 ? "danger" : pct > 60 ? "warn" : "ok";

  return (
    <div className="budget">
      <div className="budget-head">
        <span className="budget-label">Workers AI budget</span>
        <span className={`budget-value ${level}`}>
          {budget.neuronsUsed.toFixed(0)} / {budget.neuronsBudget} N
        </span>
      </div>
      <div className="budget-track">
        <div className={`budget-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="budget-note">
        {budget.calls} call{budget.calls === 1 ? "" : "s"} today · free plan allows{" "}
        {budget.freeTierDaily.toLocaleString()} Neurons/day, resets 00:00 UTC
      </p>
      {budget.exhausted && (
        <p className="budget-exhausted">
          Daily budget spent. Requests will be refused until the reset.
        </p>
      )}
    </div>
  );
}
