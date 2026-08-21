// Per-API-key request quotas (daily/monthly), independent of rate
// limiting: rate limiting shapes burstiness second to second, quotas cap
// total volume over a much longer window. Only enforced for keys with a
// quota configured — most keys have none and are skipped entirely.

import type { PipelineContext, Rejection } from "./context.js";

function periodStart(period: "day" | "month", now: Date): number {
  if (period === "day") {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

interface QuotaState {
  count: number;
  periodStartMs: number;
}

export class QuotaTracker {
  private readonly state = new Map<string, QuotaState>();

  /** Returns true (and increments the counter) if the key still has quota
   * remaining in the current period; false if it's exhausted. */
  checkAndIncrement(apiKeyId: string, limit: number, period: "day" | "month", now: Date = new Date()): boolean {
    const start = periodStart(period, now);
    let s = this.state.get(apiKeyId);
    if (s === undefined || s.periodStartMs !== start) {
      s = { count: 0, periodStartMs: start };
      this.state.set(apiKeyId, s);
    }
    if (s.count >= limit) return false;
    s.count += 1;
    return true;
  }

  usage(apiKeyId: string): number {
    return this.state.get(apiKeyId)?.count ?? 0;
  }
}

export function checkQuota(ctx: PipelineContext, tracker: QuotaTracker): Rejection | null {
  if (ctx.principal === null) return null;
  const key = ctx.config.apiKeys.find((k) => k.id === ctx.principal?.apiKeyId);
  if (key === undefined || key.quotaLimit === null || key.quotaPeriod === null) return null;

  const allowed = tracker.checkAndIncrement(ctx.principal.apiKeyId, key.quotaLimit, key.quotaPeriod);
  return allowed
    ? null
    : {
        statusCode: 429,
        error: `quota exceeded (${key.quotaLimit} requests per ${key.quotaPeriod})`,
        stage: "quota",
      };
}
