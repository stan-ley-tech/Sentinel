// Per-API-key token bucket rate limiting. Unauthenticated requests (no
// principal) are never rate limited here — a route with authRequired:false
// is public by design; protecting it is a different concern.

import type { PipelineContext, Rejection } from "./context.js";

export const DEFAULT_RATE_PER_SECOND = 10;
export const DEFAULT_BURST = 20;

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    now: number = Date.now(),
  ) {
    this.tokens = burst;
    this.lastRefillMs = now;
  }

  tryConsume(now: number = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefillMs = now;

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Entry {
  bucket: TokenBucket;
  ratePerSecond: number;
  burst: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly defaultRatePerSecond: number = DEFAULT_RATE_PER_SECOND,
    private readonly defaultBurst: number = DEFAULT_BURST,
  ) {}

  /** Returns true if allowed (a token was consumed). Rebuilds the bucket
   * if the key's configured rate/burst has changed since the last check. */
  check(apiKeyId: string, ratePerSecond: number | null, burst: number | null): boolean {
    const rate = ratePerSecond ?? this.defaultRatePerSecond;
    const cap = burst ?? this.defaultBurst;

    let entry = this.entries.get(apiKeyId);
    if (entry === undefined || entry.ratePerSecond !== rate || entry.burst !== cap) {
      entry = { bucket: new TokenBucket(rate, cap), ratePerSecond: rate, burst: cap };
      this.entries.set(apiKeyId, entry);
    }
    return entry.bucket.tryConsume();
  }
}

export function checkRateLimit(ctx: PipelineContext, limiter: RateLimiter): Rejection | null {
  if (ctx.principal === null) return null;
  const key = ctx.config.apiKeys.find((k) => k.id === ctx.principal?.apiKeyId);
  const allowed = limiter.check(
    ctx.principal.apiKeyId,
    key?.rateLimitPerSecond ?? null,
    key?.rateLimitBurst ?? null,
  );
  return allowed ? null : { statusCode: 429, error: "rate limit exceeded" };
}
