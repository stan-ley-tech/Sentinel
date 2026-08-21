// Structured audit log: one entry per request, always logged locally
// (stdout, JSON lines) and batched to the control plane's /internal/audit
// ingest endpoint so the dashboard can show recent activity. Forwarding is
// best-effort — a batch that fails to send is dropped, not retried, so a
// control-plane outage can never grow unbounded memory here; the local
// stdout log is the durable record for that window.

export interface AuditEntry {
  timestamp: string;
  method: string;
  path: string;
  clientIp: string;
  apiKeyId: string | null;
  role: string | null;
  routeId: string | null;
  allowed: boolean;
  stage: string | null;
  statusCode: number;
  durationMs: number;
}

export class AuditLogger {
  private buffer: AuditEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly controlPlaneUrl: string | null,
    private readonly internalToken: string,
    private readonly flushIntervalMs: number = 5000,
    private readonly maxBatchSize: number = 200,
  ) {}

  record(entry: AuditEntry): void {
    console.log(JSON.stringify({ audit: entry }));
    if (this.controlPlaneUrl === null) return;
    this.buffer.push(entry);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  start(): void {
    if (this.controlPlaneUrl === null) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    if (this.controlPlaneUrl === null || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await fetch(`${this.controlPlaneUrl}/internal/audit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify({ entries: batch }),
      });
    } catch (err) {
      console.error("sentinel gateway: failed to forward audit batch:", err);
    }
  }
}
