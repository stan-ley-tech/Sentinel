import type { IncomingMessage } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayConfig, RouteConfig } from "../src/config/types.js";
import type { PipelineContext } from "../src/pipeline/context.js";
import { checkReplay, ReplayGuard } from "../src/pipeline/replay.js";

function ctxWithNonce(nonce: string | undefined, requireSignature = true): PipelineContext {
  const route: RouteConfig = {
    id: "r1", pathPrefix: "/v1", upstreams: ["http://a"], stripPrefix: false,
    authRequired: true, requiredPermission: null, requireSignature,
  };
  const config: GatewayConfig = { jwtSecret: "s", roles: {}, apiKeys: [], routes: [], ipRules: [] };
  const headers = nonce === undefined ? {} : { "x-nonce": nonce };
  return {
    req: { headers } as unknown as IncomingMessage,
    method: "POST",
    pathname: "/v1",
    search: "",
    clientIp: "203.0.113.5",
    route,
    config,
    body: Buffer.alloc(0),
    principal: { apiKeyId: "key-1", role: "reader", authMethod: "api-key" },
  };
}

test("ReplayGuard: first use of a nonce is accepted", () => {
  const guard = new ReplayGuard(60_000);
  try {
    assert.equal(guard.checkAndRecord("key-1", "nonce-1"), true);
  } finally {
    guard.stop();
  }
});

test("ReplayGuard: reusing the same nonce for the same key is rejected", () => {
  const guard = new ReplayGuard(60_000);
  try {
    assert.equal(guard.checkAndRecord("key-1", "nonce-1"), true);
    assert.equal(guard.checkAndRecord("key-1", "nonce-1"), false);
  } finally {
    guard.stop();
  }
});

test("ReplayGuard: the same nonce is independent per API key", () => {
  const guard = new ReplayGuard(60_000);
  try {
    assert.equal(guard.checkAndRecord("key-1", "nonce-1"), true);
    assert.equal(guard.checkAndRecord("key-2", "nonce-1"), true);
  } finally {
    guard.stop();
  }
});

test("checkReplay: skips when the route does not require a signature", () => {
  const guard = new ReplayGuard(60_000);
  try {
    const ctx = ctxWithNonce("nonce-1", false);
    assert.equal(checkReplay(ctx, guard), null);
  } finally {
    guard.stop();
  }
});

test("checkReplay: passes a fresh nonce and rejects it the second time", () => {
  const guard = new ReplayGuard(60_000);
  try {
    const ctx = ctxWithNonce("nonce-1");
    assert.equal(checkReplay(ctx, guard), null);
    const rejection = checkReplay(ctxWithNonce("nonce-1"), guard);
    assert.equal(rejection?.statusCode, 401);
  } finally {
    guard.stop();
  }
});
