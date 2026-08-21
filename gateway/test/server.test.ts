import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import type { GatewayConfig } from "../src/config/types.js";
import { emptyConfig } from "../src/config/types.js";
import { createServer } from "../src/server.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

test("proxies a matching request to the upstream and returns its response", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const upstreamPort = await listen(upstream);

  const config: GatewayConfig = {
    ...emptyConfig(),
    routes: [
      {
        id: "r1",
        pathPrefix: "/v1/orders",
        upstreams: [`http://127.0.0.1:${upstreamPort}`],
        stripPrefix: true,
        authRequired: false,
        requiredPermission: null,
      },
    ],
  };

  const gateway = createServer(() => config);
  const gatewayPort = await listen(gateway);

  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/orders/123?x=1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path: string; method: string };
    assert.equal(body.path, "/123?x=1");
    assert.equal(body.method, "GET");
  } finally {
    gateway.close();
    upstream.close();
  }
});

test("returns 404 for an unmatched route", async () => {
  const gateway = createServer(() => emptyConfig());
  const port = await listen(gateway);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    gateway.close();
  }
});

test("returns 503 when no configured upstream is healthy", async () => {
  const config: GatewayConfig = {
    ...emptyConfig(),
    routes: [
      {
        id: "r1",
        pathPrefix: "/v1/orders",
        upstreams: ["http://127.0.0.1:1"],
        stripPrefix: false,
        authRequired: false,
        requiredPermission: null,
      },
    ],
  };
  const gateway = createServer(() => config, () => false);
  const port = await listen(gateway);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders`);
    assert.equal(res.status, 503);
  } finally {
    gateway.close();
  }
});

test("returns 502 when the upstream connection fails", async () => {
  const config: GatewayConfig = {
    ...emptyConfig(),
    routes: [
      {
        id: "r1",
        pathPrefix: "/v1/orders",
        upstreams: ["http://127.0.0.1:1"], // nothing listens on port 1
        stripPrefix: false,
        authRequired: false,
        requiredPermission: null,
      },
    ],
  };
  const gateway = createServer(() => config); // isHealthy defaults to true
  const port = await listen(gateway);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders`);
    assert.equal(res.status, 502);
  } finally {
    gateway.close();
  }
});

test("/healthz responds without needing any configured route", async () => {
  const gateway = createServer(() => emptyConfig());
  const port = await listen(gateway);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  } finally {
    gateway.close();
  }
});
