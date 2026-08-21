// Wires the security pipeline, router, circuit breaker/health checks,
// reverse proxy, and observability into an HTTP server. getConfig is
// injected (rather than taking a ConfigClient directly) so tests can
// drive the server with a fixed, in-memory config with no network
// involved. isHealthyOverride, if given, fully replaces the built-in
// health-checker+circuit-breaker availability check. observability, if
// given, enables audit-log and metrics forwarding to the control plane —
// tests omit it, which keeps them network-free and console-quiet.

import http from "node:http";
import { URL } from "node:url";

import type { GatewayConfig } from "./config/types.js";
import { AuditLogger, type AuditEntry } from "./observability/auditLog.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { MetricsReporter } from "./observability/metricsReporter.js";
import { createPipelineDeps, runPipeline } from "./pipeline/pipeline.js";
import { CircuitBreaker } from "./routing/circuitBreaker.js";
import { collectUpstreams, HealthChecker } from "./routing/healthCheck.js";
import { proxyRequest } from "./routing/proxy.js";
import { Router } from "./routing/router.js";

export interface ObservabilityOptions {
  controlPlaneUrl: string;
  internalToken: string;
}

export interface ResilienceOptions {
  /** Consecutive failures before the circuit breaker opens. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a half-open probe.
   * Default 30s in production; operators (and this project's own
   * integration test / benchmark) may want it much shorter to observe
   * recovery quickly. */
  resetTimeoutMs?: number;
  /** Health check poll interval. Default 5s. */
  healthCheckIntervalMs?: number;
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServer(
  getConfig: () => GatewayConfig,
  isHealthyOverride?: (upstream: string) => boolean,
  observability?: ObservabilityOptions,
  resilience?: ResilienceOptions,
): http.Server {
  const circuitBreaker = new CircuitBreaker(resilience?.failureThreshold, resilience?.resetTimeoutMs);
  const healthChecker = new HealthChecker(
    () => collectUpstreams(getConfig().routes),
    resilience?.healthCheckIntervalMs,
  );
  const deps = createPipelineDeps();
  const metrics = new MetricsRegistry();
  const auditLogger = new AuditLogger(observability?.controlPlaneUrl ?? null, observability?.internalToken ?? "");
  const upstreamStatuses = () =>
    collectUpstreams(getConfig().routes).map((upstream) => ({
      upstream,
      healthy: healthChecker.isHealthy(upstream),
      circuitState: circuitBreaker.state(upstream),
    }));
  const metricsReporter = new MetricsReporter(
    observability?.controlPlaneUrl ?? null,
    observability?.internalToken ?? "",
    () => metrics.snapshot(upstreamStatuses()),
  );

  const isAvailable =
    isHealthyOverride ??
    ((upstream: string) => healthChecker.isHealthy(upstream) && circuitBreaker.canAttempt(upstream));
  const router = new Router(getConfig, isAvailable);

  function audit(partial: Omit<AuditEntry, "timestamp">): void {
    auditLogger.record({ timestamp: new Date().toISOString(), ...partial });
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const startedAt = Date.now();
      const url = new URL(req.url ?? "/", "http://sentinel.local");

      if (url.pathname === "/healthz") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (url.pathname === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(metrics.toPrometheusText(upstreamStatuses()));
        return;
      }

      const route = router.match(url.pathname);
      if (route === null) {
        sendJson(res, 404, { error: "no matching route" });
        return;
      }

      const config = getConfig();
      const { rejection, bufferedBody, principal, clientIp } = await runPipeline(
        req,
        url.pathname,
        url.search,
        route,
        config,
        deps,
      );

      if (rejection !== null) {
        metrics.recordRejection(rejection.stage);
        audit({
          method: req.method ?? "GET", path: url.pathname, clientIp,
          apiKeyId: principal?.apiKeyId ?? null, role: principal?.role ?? null, routeId: route.id,
          allowed: false, stage: rejection.stage, statusCode: rejection.statusCode,
          durationMs: Date.now() - startedAt,
        });
        sendJson(res, rejection.statusCode, { error: rejection.error });
        return;
      }

      const upstream = router.pickUpstream(route);
      if (upstream === null) {
        audit({
          method: req.method ?? "GET", path: url.pathname, clientIp,
          apiKeyId: principal?.apiKeyId ?? null, role: principal?.role ?? null, routeId: route.id,
          allowed: false, stage: "no_healthy_upstream", statusCode: 503, durationMs: Date.now() - startedAt,
        });
        sendJson(res, 503, { error: "no healthy upstream for this route" });
        return;
      }

      const forwardPath = router.buildForwardPath(route, url.pathname, url.search);

      try {
        const result = await proxyRequest(req, res, upstream, forwardPath, bufferedBody);
        if (result.statusCode >= 500) {
          circuitBreaker.recordFailure(upstream);
        } else {
          circuitBreaker.recordSuccess(upstream);
        }
        metrics.recordRequest(route.id, result.statusCode, result.durationMs);
        audit({
          method: req.method ?? "GET", path: url.pathname, clientIp,
          apiKeyId: principal?.apiKeyId ?? null, role: principal?.role ?? null, routeId: route.id,
          allowed: true, stage: null, statusCode: result.statusCode, durationMs: result.durationMs,
        });
      } catch (err) {
        circuitBreaker.recordFailure(upstream);
        const durationMs = Date.now() - startedAt;
        metrics.recordRequest(route.id, 502, durationMs);
        audit({
          method: req.method ?? "GET", path: url.pathname, clientIp,
          apiKeyId: principal?.apiKeyId ?? null, role: principal?.role ?? null, routeId: route.id,
          allowed: false, stage: "upstream_error", statusCode: 502, durationMs,
        });
        console.error("sentinel gateway: proxy error:", err);
        if (!res.headersSent) {
          sendJson(res, 502, { error: "upstream request failed" });
        } else {
          res.destroy();
        }
      }
    })();
  });

  if (isHealthyOverride === undefined) {
    healthChecker.start();
  }
  auditLogger.start();
  metricsReporter.start();

  server.on("close", () => {
    deps.replayGuard.stop();
    healthChecker.stop();
    auditLogger.stop();
    metricsReporter.stop();
  });

  return server;
}
