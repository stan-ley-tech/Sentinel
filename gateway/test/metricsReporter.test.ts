import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import type { MetricsSnapshot } from "../src/observability/metrics.js";
import { MetricsReporter } from "../src/observability/metricsReporter.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

const emptySnapshot: MetricsSnapshot = { requests: [], avgLatencyMs: [], rejections: [], upstreams: [] };

test("push: does nothing when forwarding is disabled", async () => {
  const reporter = new MetricsReporter(null, "token", () => emptySnapshot);
  await assert.doesNotReject(() => reporter.push());
});

test("push: posts the built snapshot to /internal/metrics with the bearer token", async () => {
  let received: unknown;
  let authHeader: string | undefined;
  const server = http.createServer((req, res) => {
    authHeader = req.headers.authorization;
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200);
      res.end();
    });
  });
  const port = await listen(server);

  try {
    const snapshot: MetricsSnapshot = {
      requests: [{ route: "r1", status: 200, count: 5 }],
      avgLatencyMs: [{ route: "r1", avgMs: 12.5 }],
      rejections: [],
      upstreams: [],
    };
    const reporter = new MetricsReporter(`http://127.0.0.1:${port}`, "secret-token", () => snapshot);
    await reporter.push();

    assert.equal(authHeader, "Bearer secret-token");
    assert.deepEqual(received, snapshot);
  } finally {
    server.close();
  }
});

test("push: logs and swallows the error when the control plane is unreachable", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const reporter = new MetricsReporter("http://127.0.0.1:1", "token", () => emptySnapshot);
    await assert.doesNotReject(() => reporter.push());
  } finally {
    console.error = originalError;
  }
});
