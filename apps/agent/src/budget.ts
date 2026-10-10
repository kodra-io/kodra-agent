import type { ModelPrice } from '@kodra-agent/schema';
import { costOf, priceFor, readAudit } from './console/data.ts';

/** This month's estimated spend against the budget. `spent` is null without a known price. */
export interface BudgetState {
  month: string;
  limit: number | null;
  spent: number | null;
  /** True when the budget is set, priced, and used up. */
  over: boolean;
}

/**
 * The calendar month's (UTC) estimated spend, from model.call usage in the audit log and the
 * model's price (the config's override, else the list price). Rotated-out history is not
 * counted, so the estimate can only be lower than the bill: the provider's bill is the truth.
 */
export async function budgetState(opts: {
  auditPath: string;
  model: string;
  pricing: ModelPrice | undefined;
  limit: number | undefined;
  now?: Date;
}): Promise<BudgetState> {
  const month = (opts.now ?? new Date()).toISOString().slice(0, 7);
  const priced = priceFor(opts.model, opts.pricing);
  const totals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  if (priced) {
    for (const r of await readAudit(opts.auditPath)) {
      if (r.event !== 'model.call' || !r.usage || !r.ts.startsWith(month)) continue;
      totals.calls += 1;
      totals.input += r.usage.input;
      totals.cacheRead += r.usage.cacheRead;
      totals.cacheWrite += r.usage.cacheWrite;
      totals.output += r.usage.output;
    }
  }
  const spent = priced ? (costOf(totals, priced.price) ?? 0) : null;
  const limit = opts.limit ?? null;
  return { month, limit, spent, over: limit !== null && spent !== null && spent >= limit };
}

/** The refusal for a new question when the budget is used up, or null. */
export function budgetRefusal(state: BudgetState): string | null {
  if (!state.over || state.limit === null) return null;
  return `The monthly budget of $${state.limit.toFixed(2)} is used up (about $${(state.spent ?? 0).toFixed(2)} this month), so I am not taking new questions. Alerts are still investigated. An approver can raise the budget in Settings.`;
}
