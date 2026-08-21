import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApiKeyConfig, GatewayConfig, RouteConfig } from "../src/config/types.js";
import { computeSignature } from "../src/crypto/hmac.js";
import type { PipelineContext } from "../src/pipeline/context.js";
import { verifyRequestSignature } from "../src/pipeline/signing.js";

const SIGNING_SECRET = "sign-secret";

function apiKey(): ApiKeyConfig {
  return {
    id: "key-1",
    keyHash: "hash",
    role: "reader",
    signingSecret: SIGNING_SECRET,
    enabled: true,
    rateLimitPerSecond: null,
    rateLimitBurst: null,
    quotaLimit: null,
    quotaPeriod: null,
  };
}

function ctxSigned(headers: IncomingHttpHeaders, body: Buffer, authenticated = true): PipelineContext {
  const route: RouteConfig = {
    id: "r1",
    pathPrefix: "/v1",
    upstreams: ["http://a"],
    stripPrefix: false,
    authRequired: true,
    requiredPermission: null,
    requireSignature: true,
  };
  const config: GatewayConfig = { jwtSecret: "s", roles: {}, apiKeys: [apiKey()], routes: [], ipRules: [] };
  return {
    req: { headers } as unknown as IncomingMessage,
    method: "POST",
    pathname: "/v1",
    search: "",
    clientIp: "203.0.113.5",
    route,
    config,
    body,
    principal: authenticated ? { apiKeyId: "key-1", role: "reader", authMethod: "api-key" } : null,
  };
}

test("verifyRequestSignature: skips when the route does not require a signature", () => {
  const route: RouteConfig = {
    id: "r1", pathPrefix: "/v1", upstreams: ["http://a"], stripPrefix: false,
    authRequired: false, requiredPermission: null, requireSignature: false,
  };
  const ctx: PipelineContext = {
    req: { headers: {} } as unknown as IncomingMessage, method: "GET", pathname: "/v1", search: "",
    clientIp: "203.0.113.5", route, config: { jwtSecret: "s", roles: {}, apiKeys: [], routes: [], ipRules: [] },
    body: Buffer.alloc(0), principal: null,
  };
  assert.equal(verifyRequestSignature(ctx), null);
});

test("verifyRequestSignature: rejects when unauthenticated", () => {
  const ctx = ctxSigned({}, Buffer.from("body"), false);
  assert.equal(verifyRequestSignature(ctx)?.statusCode, 401);
});

test("verifyRequestSignature: rejects missing signing headers", () => {
  const ctx = ctxSigned({}, Buffer.from("body"));
  assert.equal(verifyRequestSignature(ctx)?.statusCode, 401);
});

test("verifyRequestSignature: accepts a correctly signed request", () => {
  const body = Buffer.from('{"amount":100}');
  const timestamp = String(Date.now());
  const nonce = "nonce-1";
  const sig = computeSignature(SIGNING_SECRET, timestamp, nonce, body);

  const ctx = ctxSigned({ "x-signature": sig, "x-signature-timestamp": timestamp, "x-nonce": nonce }, body);
  assert.equal(verifyRequestSignature(ctx), null);
});

test("verifyRequestSignature: rejects a tampered body", () => {
  const timestamp = String(Date.now());
  const nonce = "nonce-1";
  const sig = computeSignature(SIGNING_SECRET, timestamp, nonce, Buffer.from("original"));

  const ctx = ctxSigned(
    { "x-signature": sig, "x-signature-timestamp": timestamp, "x-nonce": nonce },
    Buffer.from("tampered"),
  );
  assert.equal(verifyRequestSignature(ctx)?.statusCode, 401);
});

test("verifyRequestSignature: rejects a timestamp far outside the clock-skew window", () => {
  const body = Buffer.from("payload");
  const staleTimestamp = String(Date.now() - 60 * 60 * 1000); // 1 hour old
  const nonce = "nonce-1";
  const sig = computeSignature(SIGNING_SECRET, staleTimestamp, nonce, body);

  const ctx = ctxSigned({ "x-signature": sig, "x-signature-timestamp": staleTimestamp, "x-nonce": nonce }, body);
  assert.equal(verifyRequestSignature(ctx)?.statusCode, 401);
});
