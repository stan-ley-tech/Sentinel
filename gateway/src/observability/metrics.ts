// In-process metrics registry: request counts by route+status, average
// latency by route, and rejection counts by pipeline stage. Exposed both
// as Prometheus text (pull, /metrics) and as a JSON snapshot (pushed to
// the control plane's dashboard).

export interface UpstreamStatus {
  upstream: string;
  healthy: boolean;
  circuitState: "closed" | "open" | "half-open";
}

export interface MetricsSnapshot {
  requests: { route: string; status: number; count: number }[];
  avgLatencyMs: { route: string; avgMs: number }[];
  rejections: { stage: string; count: number }[];
  upstreams: UpstreamStatus[];
}

export class MetricsRegistry {
  private readonly requestCounts = new Map<string, number>(); // "route|status" -> count
  private readonly latencySumMs = new Map<string, number>(); // route -> total ms
  private readonly latencyCount = new Map<string, number>(); // route -> count
  private readonly rejectionCounts = new Map<string, number>(); // stage -> count

  recordRequest(route: string, statusCode: number, durationMs: number): void {
    const key = `${route}|${statusCode}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
    this.latencySumMs.set(route, (this.latencySumMs.get(route) ?? 0) + durationMs);
    this.latencyCount.set(route, (this.latencyCount.get(route) ?? 0) + 1);
  }

  recordRejection(stage: string): void {
    this.rejectionCounts.set(stage, (this.rejectionCounts.get(stage) ?? 0) + 1);
  }

  snapshot(upstreams: UpstreamStatus[] = []): MetricsSnapshot {
    const requests = [...this.requestCounts.entries()].map(([key, count]) => {
      const sep = key.lastIndexOf("|");
      return { route: key.slice(0, sep), status: Number(key.slice(sep + 1)), count };
    });

    const avgLatencyMs = [...this.latencySumMs.entries()].map(([route, sum]) => ({
      route,
      avgMs: Math.round((sum / (this.latencyCount.get(route) ?? 1)) * 100) / 100,
    }));

    const rejections = [...this.rejectionCounts.entries()].map(([stage, count]) => ({ stage, count }));

    return { requests, avgLatencyMs, rejections, upstreams };
  }

  toPrometheusText(upstreams: UpstreamStatus[] = []): string {
    const snap = this.snapshot(upstreams);
    const lines: string[] = [];

    lines.push("# HELP sentinel_requests_total Total requests processed, by route and status code");
    lines.push("# TYPE sentinel_requests_total counter");
    for (const r of snap.requests) {
      lines.push(`sentinel_requests_total{route="${r.route}",status="${r.status}"} ${r.count}`);
    }

    lines.push("# HELP sentinel_request_duration_ms_avg Average proxied request duration in milliseconds, by route");
    lines.push("# TYPE sentinel_request_duration_ms_avg gauge");
    for (const r of snap.avgLatencyMs) {
      lines.push(`sentinel_request_duration_ms_avg{route="${r.route}"} ${r.avgMs}`);
    }

    lines.push("# HELP sentinel_rejections_total Requests rejected by the security pipeline, by stage");
    lines.push("# TYPE sentinel_rejections_total counter");
    for (const r of snap.rejections) {
      lines.push(`sentinel_rejections_total{stage="${r.stage}"} ${r.count}`);
    }

    lines.push("# HELP sentinel_upstream_healthy Whether an upstream's last health check succeeded");
    lines.push("# TYPE sentinel_upstream_healthy gauge");
    for (const u of snap.upstreams) {
      lines.push(`sentinel_upstream_healthy{upstream="${u.upstream}"} ${u.healthy ? 1 : 0}`);
    }

    lines.push("# HELP sentinel_circuit_breaker_open Whether an upstream's circuit breaker is currently open");
    lines.push("# TYPE sentinel_circuit_breaker_open gauge");
    for (const u of snap.upstreams) {
      lines.push(`sentinel_circuit_breaker_open{upstream="${u.upstream}"} ${u.circuitState === "open" ? 1 : 0}`);
    }

    return lines.join("\n") + "\n";
  }
}
