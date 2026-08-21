// Active health checks: periodically GETs each known upstream's /healthz
// and remembers whether it answered 2xx. An upstream is optimistically
// treated as healthy until its first check completes, so a brand-new
// upstream isn't excluded from routing before the checker has had a
// chance to probe it.

export class HealthChecker {
  private readonly healthy = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getUpstreams: () => string[],
    private readonly intervalMs: number = 5000,
    private readonly timeoutMs: number = 2000,
  ) {}

  isHealthy(upstream: string): boolean {
    return this.healthy.get(upstream) ?? true;
  }

  start(): void {
    this.checkAll().catch(() => {});
    this.timer = setInterval(() => {
      this.checkAll().catch(() => {});
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async checkAll(): Promise<void> {
    await Promise.all(this.getUpstreams().map((u) => this.checkOne(u)));
  }

  private async checkOne(upstream: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${upstream}/healthz`, { signal: controller.signal });
      this.healthy.set(upstream, res.ok);
    } catch {
      this.healthy.set(upstream, false);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Deduplicated list of every upstream referenced by any route. */
export function collectUpstreams(routes: { upstreams: string[] }[]): string[] {
  return [...new Set(routes.flatMap((r) => r.upstreams))];
}
