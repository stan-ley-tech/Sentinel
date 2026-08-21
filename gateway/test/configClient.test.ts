import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { ConfigClient, parseConfig } from "../src/config/configClient.js";

function validRawConfig(): Record<string, unknown> {
  return {
    jwt_secret: "s3cr3t",
    roles: { reader: ["orders:read"] },
    api_keys: [
      {
        id: "k1",
        key_hash: "hash",
        role: "reader",
        signing_secret: "sig",
        enabled: true,
        rate_limit_per_second: 10,
        rate_limit_burst: 20,
        quota_limit: null,
        quota_period: null,
      },
    ],
    routes: [
      {
        id: "r1",
        path_prefix: "/v1/orders",
        upstreams: ["http://a"],
        strip_prefix: false,
        auth_required: true,
        required_permission: null,
        require_signature: false,
      },
    ],
    ip_rules: [{ cidr: "10.0.0.0/8", action: "deny", priority: 1 }],
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

test("parseConfig: parses a valid snapshot into camelCase config", () => {
  const config = parseConfig(validRawConfig());
  assert.equal(config.jwtSecret, "s3cr3t");
  assert.deepEqual(config.roles["reader"], { permissions: ["orders:read"] });
  assert.equal(config.apiKeys[0]?.keyHash, "hash");
  assert.equal(config.routes[0]?.pathPrefix, "/v1/orders");
  assert.equal(config.ipRules[0]?.action, "deny");
});

test("parseConfig: rejects a non-object response", () => {
  assert.throws(() => parseConfig("not an object"));
});

test("parseConfig: rejects a missing jwt_secret", () => {
  const raw = validRawConfig();
  delete raw.jwt_secret;
  assert.throws(() => parseConfig(raw));
});

test("parseConfig: rejects an invalid ip rule action", () => {
  const raw = validRawConfig();
  raw.ip_rules = [{ cidr: "10.0.0.0/8", action: "block", priority: 1 }];
  assert.throws(() => parseConfig(raw));
});

test("parseConfig: defaults ip rule priority to 0 when absent", () => {
  const raw = validRawConfig();
  raw.ip_rules = [{ cidr: "10.0.0.0/8", action: "deny" }];
  const config = parseConfig(raw);
  assert.equal(config.ipRules[0]?.priority, 0);
});

test("ConfigClient.refresh: authenticates, fetches, and parses the snapshot", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer secret-token");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(validRawConfig()));
  });
  const port = await listen(server);

  try {
    const client = new ConfigClient(`http://127.0.0.1:${port}`, "secret-token");
    await client.refresh();
    assert.equal(client.config.jwtSecret, "s3cr3t");
    assert.equal(client.config.routes.length, 1);
  } finally {
    server.close();
  }
});

test("ConfigClient.refresh: throws on a non-2xx response", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid token" }));
  });
  const port = await listen(server);

  try {
    const client = new ConfigClient(`http://127.0.0.1:${port}`, "wrong-token");
    await assert.rejects(() => client.refresh());
  } finally {
    server.close();
  }
});
