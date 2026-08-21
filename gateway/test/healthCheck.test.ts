import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { collectUpstreams, HealthChecker } from "../src/routing/healthCheck.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

test("collectUpstreams: deduplicates across routes", () => {
  const routes = [{ upstreams: ["http://a", "http://b"] }, { upstreams: ["http://b", "http://c"] }];
  assert.deepEqual(collectUpstreams(routes), ["http://a", "http://b", "http://c"]);
});

test("isHealthy: optimistically true before any check has run", () => {
  const checker = new HealthChecker(() => ["http://never-checked"]);
  assert.equal(checker.isHealthy("http://never-checked"), true);
});

test("checkAll: marks an upstream healthy when /healthz responds 2xx", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/healthz") res.writeHead(200);
    res.end();
  });
  const port = await listen(upstream);
  const url = `http://127.0.0.1:${port}`;
  const checker = new HealthChecker(() => [url]);

  try {
    await checker.checkAll();
    assert.equal(checker.isHealthy(url), true);
  } finally {
    upstream.close();
  }
});

test("checkAll: marks an upstream unhealthy when /healthz responds 5xx", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const port = await listen(upstream);
  const url = `http://127.0.0.1:${port}`;
  const checker = new HealthChecker(() => [url]);

  try {
    await checker.checkAll();
    assert.equal(checker.isHealthy(url), false);
  } finally {
    upstream.close();
  }
});

test("checkAll: marks an unreachable upstream unhealthy", async () => {
  const checker = new HealthChecker(() => ["http://127.0.0.1:1"]);
  await checker.checkAll();
  assert.equal(checker.isHealthy("http://127.0.0.1:1"), false);
});

test("checkAll: a previously-unhealthy upstream recovers once it responds again", async () => {
  let healthy = false;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(healthy ? 200 : 503);
    res.end();
  });
  const port = await listen(upstream);
  const url = `http://127.0.0.1:${port}`;
  const checker = new HealthChecker(() => [url]);

  try {
    await checker.checkAll();
    assert.equal(checker.isHealthy(url), false);

    healthy = true;
    await checker.checkAll();
    assert.equal(checker.isHealthy(url), true);
  } finally {
    upstream.close();
  }
});
