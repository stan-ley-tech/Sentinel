import { createHash, createHmac } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";

import { authenticate } from "../src/pipeline/auth.js";
import type { PipelineContext } from "../src/pipeline/context.js";
import type { ApiKeyConfig, GatewayConfig, RouteConfig } from "../src/config/types.js";

function fakeReq(headers: IncomingHttpHeaders): IncomingMessage {
  return { headers, socket: { remoteAddress: "203.0.113.5" } } as unknown as IncomingMessage;
}

function base64Url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signToken(claims: Record<string, unknown>, secret: string): string {
  const headerB64 = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payloadB64 = base64Url(JSON.stringify({ ...claims, iat: now, exp: now + 3600 }));
  const sig = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  return `${headerB64}.${payloadB64}.${base64Url(sig)}`;
}

function apiKey(overrides: Partial<ApiKeyConfig> = {}): ApiKeyConfig {
  return {
    id: "key-1",
    keyHash: createHash("sha256").update("plaintext-key").digest("hex"),
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

function route(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: "r1",
    pathPrefix: "/v1",
    upstreams: ["http://a"],
    stripPrefix: false,
    authRequired: true,
    requiredPermission: null,
    requireSignature: false,
    ...overrides,
  };
}

function ctxWith(headers: IncomingHttpHeaders, keys: ApiKeyConfig[], routeOverrides: Partial<RouteConfig> = {}): PipelineContext {
  const config: GatewayConfig = { jwtSecret: "jwt-secret", roles: {}, apiKeys: keys, routes: [], ipRules: [] };
  return {
    req: fakeReq(headers),
    method: "GET",
    pathname: "/v1",
    search: "",
    clientIp: "203.0.113.5",
    route: route(routeOverrides),
    config,
    body: Buffer.alloc(0),
    principal: null,
  };
}

test("authenticate: skips entirely when the route does not require auth", () => {
  const ctx = ctxWith({}, [], { authRequired: false });
  assert.equal(authenticate(ctx), null);
  assert.equal(ctx.principal, null);
});

test("authenticate: rejects when no credentials are present", () => {
  const ctx = ctxWith({}, []);
  const rejection = authenticate(ctx);
  assert.notEqual(rejection, null);
  assert.equal(rejection?.statusCode, 401);
});

test("authenticate: accepts a valid X-Api-Key and sets the principal", () => {
  const key = apiKey();
  const ctx = ctxWith({ "x-api-key": "plaintext-key" }, [key]);
  assert.equal(authenticate(ctx), null);
  assert.deepEqual(ctx.principal, { apiKeyId: "key-1", role: "reader", authMethod: "api-key" });
});

test("authenticate: rejects an unknown X-Api-Key", () => {
  const ctx = ctxWith({ "x-api-key": "wrong-key" }, [apiKey()]);
  assert.equal(authenticate(ctx)?.statusCode, 401);
});

test("authenticate: rejects a disabled key even if the header value is correct", () => {
  const ctx = ctxWith({ "x-api-key": "plaintext-key" }, [apiKey({ enabled: false })]);
  assert.equal(authenticate(ctx)?.statusCode, 401);
});

test("authenticate: accepts a valid JWT bearer token and sets the principal", () => {
  const key = apiKey({ id: "key-2", role: "writer" });
  const token = signToken({ sub: "key-2" }, "jwt-secret");
  const ctx = ctxWith({ authorization: `Bearer ${token}` }, [key]);
  assert.equal(authenticate(ctx), null);
  assert.deepEqual(ctx.principal, { apiKeyId: "key-2", role: "writer", authMethod: "jwt" });
});

test("authenticate: uses the CURRENT role from config, not a stale role claim in the token", () => {
  const token = signToken({ sub: "key-1", role: "admin" }, "jwt-secret"); // claims admin
  const key = apiKey({ role: "reader" }); // but config now says reader
  const ctx = ctxWith({ authorization: `Bearer ${token}` }, [key]);
  authenticate(ctx);
  assert.equal(ctx.principal?.role, "reader");
});

test("authenticate: rejects a JWT signed with the wrong secret", () => {
  const token = signToken({ sub: "key-1" }, "wrong-secret");
  const ctx = ctxWith({ authorization: `Bearer ${token}` }, [apiKey()]);
  assert.equal(authenticate(ctx)?.statusCode, 401);
});

test("authenticate: rejects a JWT for a key that no longer exists", () => {
  const token = signToken({ sub: "deleted-key" }, "jwt-secret");
  const ctx = ctxWith({ authorization: `Bearer ${token}` }, [apiKey()]);
  assert.equal(authenticate(ctx)?.statusCode, 401);
});

test("authenticate: X-Api-Key takes precedence when both credentials are present", () => {
  const apiKeyPrincipal = apiKey({ id: "key-1", role: "reader" });
  const token = signToken({ sub: "key-1" }, "jwt-secret");
  const ctx = ctxWith({ "x-api-key": "plaintext-key", authorization: `Bearer ${token}` }, [apiKeyPrincipal]);
  authenticate(ctx);
  assert.equal(ctx.principal?.authMethod, "api-key");
});
