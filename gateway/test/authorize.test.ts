import type { IncomingMessage } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayConfig, RouteConfig } from "../src/config/types.js";
import type { PipelineContext, Principal } from "../src/pipeline/context.js";
import { authorize } from "../src/pipeline/authorize.js";

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

function ctxWith(
  routeOverrides: Partial<RouteConfig>,
  roles: GatewayConfig["roles"],
  principal: Principal | null,
): PipelineContext {
  return {
    req: {} as IncomingMessage,
    method: "GET",
    pathname: "/v1",
    search: "",
    clientIp: "203.0.113.5",
    route: route(routeOverrides),
    config: { jwtSecret: "s", roles, apiKeys: [], routes: [], ipRules: [] },
    body: Buffer.alloc(0),
    principal,
  };
}

test("authorize: passes when the route requires no permission", () => {
  const ctx = ctxWith({ requiredPermission: null }, {}, null);
  assert.equal(authorize(ctx), null);
});

test("authorize: rejects an unauthenticated caller on a permission-gated route", () => {
  const ctx = ctxWith({ requiredPermission: "orders:read" }, {}, null);
  assert.equal(authorize(ctx)?.statusCode, 401);
});

test("authorize: rejects a role missing the required permission", () => {
  const ctx = ctxWith(
    { requiredPermission: "orders:write" },
    { reader: { permissions: ["orders:read"] } },
    { apiKeyId: "k1", role: "reader", authMethod: "api-key" },
  );
  assert.equal(authorize(ctx)?.statusCode, 403);
});

test("authorize: allows a role holding the exact required permission", () => {
  const ctx = ctxWith(
    { requiredPermission: "orders:read" },
    { reader: { permissions: ["orders:read"] } },
    { apiKeyId: "k1", role: "reader", authMethod: "api-key" },
  );
  assert.equal(authorize(ctx), null);
});

test("authorize: a wildcard '*' permission satisfies any requirement", () => {
  const ctx = ctxWith(
    { requiredPermission: "orders:write" },
    { admin: { permissions: ["*"] } },
    { apiKeyId: "k1", role: "admin", authMethod: "api-key" },
  );
  assert.equal(authorize(ctx), null);
});

test("authorize: an unknown role (not in config) is treated as having no permissions", () => {
  const ctx = ctxWith(
    { requiredPermission: "orders:read" },
    {},
    { apiKeyId: "k1", role: "ghost-role", authMethod: "api-key" },
  );
  assert.equal(authorize(ctx)?.statusCode, 403);
});
