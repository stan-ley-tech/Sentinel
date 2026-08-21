// Periodically pushes a metrics snapshot to the control plane's
// /internal/metrics endpoint, which is what feeds the dashboard's live
// traffic/circuit/health view. Best-effort, same rationale as AuditLogger:
// a failed push is logged and dropped, not retried.

import type { MetricsSnapshot } from "./metrics.js";

export class MetricsReporter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly controlPlaneUrl: string | null,
    private readonly internalToken: string,
    private readonly buildSnapshot: () => MetricsSnapshot,
    private readonly intervalMs: number = 5000,
  ) {}

  start(): void {
    if (this.controlPlaneUrl === null) return;
    this.timer = setInterval(() => void this.push(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async push(): Promise<void> {
    if (this.controlPlaneUrl === null) return;
    try {
      await fetch(`${this.controlPlaneUrl}/internal/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify(this.buildSnapshot()),
      });
    } catch (err) {
      console.error("sentinel gateway: failed to push metrics snapshot:", err);
    }
  }
}
