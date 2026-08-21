// Forwards a request to an upstream and streams its response back. Accepts
// an optional pre-buffered body: later pipeline stages (request signing,
// replay protection) need to read the full body to verify it, which
// consumes the original stream — once that happens, the buffered bytes are
// passed through here instead of re-reading an already-drained stream.

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface ProxyResult {
  statusCode: number;
  durationMs: number;
}

export function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetBaseUrl: string,
  forwardPath: string,
  bufferedBody?: Buffer,
): Promise<ProxyResult> {
  const target = new URL(forwardPath, targetBaseUrl);
  const client = target.protocol === "https:" ? https : http;
  const startedAt = Date.now();

  // host/connection are hop-by-hop or target-specific: don't forward the
  // caller's values verbatim.
  const { host: _host, connection: _connection, ...forwardHeaders } = req.headers;

  return new Promise((resolve, reject) => {
    const proxyReq = client.request(
      target,
      { method: req.method, headers: { ...forwardHeaders, host: target.host } },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 502;
        res.writeHead(statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("end", () => resolve({ statusCode, durationMs: Date.now() - startedAt }));
        proxyRes.on("error", (err) => reject(err));
      },
    );

    proxyReq.on("error", (err) => reject(err));

    if (bufferedBody !== undefined) {
      proxyReq.end(bufferedBody);
    } else {
      req.pipe(proxyReq);
    }
  });
}
