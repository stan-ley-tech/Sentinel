// Replay protection: rejects a (apiKeyId, nonce) pair that's already been
// seen within the signing window. Runs after signature verification
// succeeds — recording a nonce for a request with a bad signature would
// let an attacker burn a victim's nonces without ever presenting a valid
// one.

import type { PipelineContext, Rejection } from "./context.js";
import { MAX_CLOCK_SKEW_MS } from "./signing.js";

export class ReplayGuard {
  private readonly seen = new Map<string, number>(); // "apiKeyId:nonce" -> expiresAt
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly windowMs: number = MAX_CLOCK_SKEW_MS) {
    this.cleanupTimer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.cleanupTimer.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  /** Records apiKeyId+nonce and returns true if this is the first time
   * it's been seen within the window; false if it's a replay. */
  checkAndRecord(apiKeyId: string, nonce: string): boolean {
    const key = `${apiKeyId}:${nonce}`;
    const now = Date.now();
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, now + this.windowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }
}

export function checkReplay(ctx: PipelineContext, guard: ReplayGuard): Rejection | null {
  if (!ctx.route.requireSignature || ctx.principal === null) return null;

  const nonce = ctx.req.headers["x-nonce"];
  if (typeof nonce !== "string") return null; // signing.ts already rejects a missing nonce

  if (!guard.checkAndRecord(ctx.principal.apiKeyId, nonce)) {
    return { statusCode: 401, error: "replayed request (nonce already used)" };
  }
  return null;
}
