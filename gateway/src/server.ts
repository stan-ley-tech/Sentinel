// Wires the router and reverse proxy into an HTTP server. getConfig is
// injected (rather than taking a ConfigClient directly) so tests can drive
// the server with a fixed, in-memory config with no network involved.

import http from "node:http";
import { URL } from "node:url";

import type { GatewayConfig } from "./config/types.js";
import { proxyRequest } from "./routing/proxy.js";
import { Router } from "./routing/router.js";

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServer(
  getConfig: () => GatewayConfig,
  isHealthy: (upstream: string) => boolean = () => true,
): http.Server {
  const router = new Router(getConfig, isHealthy);

  return http.createServer((req, res) => {
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

      const upstream = router.pickUpstream(route);
      if (upstream === null) {
        sendJson(res, 503, { error: "no healthy upstream for this route" });
        return;
      }

      const forwardPath = router.buildForwardPath(route, url.pathname, url.search);

      try {
        await proxyRequest(req, res, upstream, forwardPath);
      } catch (err) {
        console.error("sentinel gateway: proxy error:", err);
        if (!res.headersSent) {
          sendJson(res, 502, { error: "upstream request failed" });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
