// Wires the security pipeline, router, circuit breaker/health checks, and
// reverse proxy into an HTTP server. getConfig is injected (rather than
// taking a ConfigClient directly) so tests can drive the server with a
// fixed, in-memory config with no network involved. isHealthyOverride, if
// given, fully replaces the built-in health-checker+circuit-breaker
// availability check — tests use it to simulate upstream health without
// needing real /healthz endpoints or waiting on real timers.

import http from "node:http";
import { URL } from "node:url";

import type { GatewayConfig } from "./config/types.js";
import { createPipelineDeps, runPipeline } from "./pipeline/pipeline.js";
import { CircuitBreaker } from "./routing/circuitBreaker.js";
import { collectUpstreams, HealthChecker } from "./routing/healthCheck.js";
import { proxyRequest } from "./routing/proxy.js";
import { Router } from "./routing/router.js";

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServer(
  getConfig: () => GatewayConfig,
  isHealthyOverride?: (upstream: string) => boolean,
): http.Server {
  const circuitBreaker = new CircuitBreaker();
  const healthChecker = new HealthChecker(() => collectUpstreams(getConfig().routes));
  const deps = createPipelineDeps();

  const isAvailable =
    isHealthyOverride ??
    ((upstream: string) => healthChecker.isHealthy(upstream) && circuitBreaker.canAttempt(upstream));
  const router = new Router(getConfig, isAvailable);

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://sentinel.local");

      if (url.pathname === "/healthz") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      const route = router.match(url.pathname);
      if (route === null) {
        sendJson(res, 404, { error: "no matching route" });
        return;
      }

      const config = getConfig();
      const { rejection, bufferedBody } = await runPipeline(req, url.pathname, url.search, route, config, deps);
      if (rejection !== null) {
        sendJson(res, rejection.statusCode, { error: rejection.error });
        return;
      }

      const upstream = router.pickUpstream(route);
      if (upstream === null) {
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
      } catch (err) {
        circuitBreaker.recordFailure(upstream);
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
  server.on("close", () => {
    deps.replayGuard.stop();
    healthChecker.stop();
  });

  return server;
}
