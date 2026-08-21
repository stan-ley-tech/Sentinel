// A standard 3-state circuit breaker per upstream: closed (normal) ->
// open (short-circuiting, after too many consecutive failures) ->
// half-open (a single probe allowed once resetTimeoutMs has passed) ->
// back to closed on success or open again on failure.

export type BreakerState = "closed" | "open" | "half-open";

interface Entry {
  state: BreakerState;
  consecutiveFailures: number;
  openedAtMs: number;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 30_000,
  ) {}

  private entry(upstream: string): Entry {
    let e = this.entries.get(upstream);
    if (e === undefined) {
      e = { state: "closed", consecutiveFailures: 0, openedAtMs: 0 };
      this.entries.set(upstream, e);
    }
    return e;
  }

  /** Whether a request may currently be attempted against this upstream. */
  canAttempt(upstream: string, now: number = Date.now()): boolean {
    const e = this.entry(upstream);
    if (e.state === "closed") return true;
    if (e.state === "half-open") return true; // the in-flight probe
    if (now - e.openedAtMs >= this.resetTimeoutMs) {
      e.state = "half-open";
      return true;
    }
    return false;
  }

  recordSuccess(upstream: string): void {
    const e = this.entry(upstream);
    e.state = "closed";
    e.consecutiveFailures = 0;
  }

  recordFailure(upstream: string, now: number = Date.now()): void {
    const e = this.entry(upstream);
    e.consecutiveFailures += 1;
    if (e.state === "half-open" || e.consecutiveFailures >= this.failureThreshold) {
      e.state = "open";
      e.openedAtMs = now;
    }
  }

  state(upstream: string): BreakerState {
    return this.entry(upstream).state;
  }
}
