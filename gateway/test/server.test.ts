import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import type { ApiKeyConfig, GatewayConfig } from "../src/config/types.js";
import { emptyConfig } from "../src/config/types.js";
import { computeSignature } from "../src/crypto/hmac.js";
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
        requireSignature: false,
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
        requireSignature: false,
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
        requireSignature: false,
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

function apiKey(overrides: Partial<ApiKeyConfig> = {}): ApiKeyConfig {
  return {
    id: "key-1",
    keyHash: createHash("sha256").update("test-key").digest("hex"),
    role: "reader",
    signingSecret: "sign-secret",
    enabled: true,
    rateLimitPerSecond: null,
    rateLimitBurst: null,
    quotaLimit: null,
    quotaPeriod: null,
    ...overrides,
  };
}

test("rejects an auth-required route with no credentials", async () => {
  const config: GatewayConfig = {
    ...emptyConfig(),
    apiKeys: [apiKey()],
    routes: [
      {
        id: "r1", pathPrefix: "/v1/orders", upstreams: ["http://127.0.0.1:1"],
        stripPrefix: false, authRequired: true, requiredPermission: null, requireSignature: false,
      },
    ],
  };
  const gateway = createServer(() => config);
  const port = await listen(gateway);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders`);
    assert.equal(res.status, 401);
  } finally {
    gateway.close();
  }
});

test("proxies an auth-required route once a valid API key is presented", async () => {
  const upstream = http.createServer((_req, res) => res.end("ok"));
  const upstreamPort = await listen(upstream);

  const config: GatewayConfig = {
    ...emptyConfig(),
    apiKeys: [apiKey()],
    routes: [
      {
        id: "r1", pathPrefix: "/v1/orders", upstreams: [`http://127.0.0.1:${upstreamPort}`],
        stripPrefix: false, authRequired: true, requiredPermission: null, requireSignature: false,
      },
    ],
  };
  const gateway = createServer(() => config);
  const port = await listen(gateway);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders`, { headers: { "x-api-key": "test-key" } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    gateway.close();
    upstream.close();
  }
});

test("rejects a request denied by an IP rule before it ever reaches auth", async () => {
  const config: GatewayConfig = {
    ...emptyConfig(),
    ipRules: [{ cidr: "127.0.0.1/32", action: "deny", priority: 0 }],
    routes: [
      {
        id: "r1", pathPrefix: "/v1/orders", upstreams: ["http://127.0.0.1:1"],
        stripPrefix: false, authRequired: false, requiredPermission: null, requireSignature: false,
      },
    ],
  };
  const gateway = createServer(() => config);
  const port = await listen(gateway);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders`);
    assert.equal(res.status, 403);
  } finally {
    gateway.close();
  }
});

test("a signature-required route proxies with a valid signature and rejects a tampered body", async () => {
  const upstream = http.createServer((req, res) => {
    let received = "";
    req.on("data", (chunk: Buffer) => (received += chunk.toString()));
    req.on("end", () => res.end(received));
  });
  const upstreamPort = await listen(upstream);

  const config: GatewayConfig = {
    ...emptyConfig(),
    apiKeys: [apiKey()],
    routes: [
      {
        id: "r1", pathPrefix: "/v1/orders", upstreams: [`http://127.0.0.1:${upstreamPort}`],
        stripPrefix: false, authRequired: true, requiredPermission: null, requireSignature: true,
      },
    ],
  };
  const gateway = createServer(() => config);
  const port = await listen(gateway);

  try {
    const body = '{"amount":100}';
    const timestamp = String(Date.now());
    const nonce = "smoke-nonce-1";
    const signature = computeSignature("sign-secret", timestamp, nonce, Buffer.from(body));

    const ok = await fetch(`http://127.0.0.1:${port}/v1/orders`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "x-signature": signature,
        "x-signature-timestamp": timestamp,
        "x-nonce": nonce,
      },
      body,
    });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), body);

    // Same nonce again: rejected as a replay, even with a correct signature
    // for THIS (identical) body.
    const replay = await fetch(`http://127.0.0.1:${port}/v1/orders`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "x-signature": signature,
        "x-signature-timestamp": timestamp,
        "x-nonce": nonce,
      },
      body,
    });
    assert.equal(replay.status, 401);

    // A fresh nonce but a tampered body: signature no longer matches.
    const tampered = await fetch(`http://127.0.0.1:${port}/v1/orders`, {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "x-signature": signature,
        "x-signature-timestamp": timestamp,
        "x-nonce": "different-nonce",
      },
      body: '{"amount":999}',
    });
    assert.equal(tampered.status, 401);
  } finally {
    gateway.close();
    upstream.close();
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
