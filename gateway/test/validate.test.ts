import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayConfig, RouteConfig } from "../src/config/types.js";
import type { PipelineContext } from "../src/pipeline/context.js";
import { MAX_BODY_BYTES, validateRequest } from "../src/pipeline/validate.js";

function ctxWithHeaders(headers: IncomingHttpHeaders): PipelineContext {
  const route: RouteConfig = {
    id: "r1",
    pathPrefix: "/v1",
    upstreams: ["http://a"],
    stripPrefix: false,
    authRequired: false,
    requiredPermission: null,
    requireSignature: false,
  };
  const config: GatewayConfig = { jwtSecret: "s", roles: {}, apiKeys: [], routes: [], ipRules: [] };
  return {
    req: { headers } as unknown as IncomingMessage,
    method: "POST",
    pathname: "/v1",
    search: "",
    clientIp: "203.0.113.5",
    route,
    config,
    body: Buffer.alloc(0),
    principal: null,
  };
}

test("validateRequest: passes with no content-length header", () => {
  assert.equal(validateRequest(ctxWithHeaders({})), null);
});

test("validateRequest: passes for a body within the size limit", () => {
  assert.equal(validateRequest(ctxWithHeaders({ "content-length": "1024" })), null);
});

test("validateRequest: rejects a body over the size limit", () => {
  const rejection = validateRequest(ctxWithHeaders({ "content-length": String(MAX_BODY_BYTES + 1) }));
  assert.notEqual(rejection, null);
  assert.equal(rejection?.statusCode, 413);
});

test("validateRequest: ignores a non-numeric content-length rather than crashing", () => {
  assert.equal(validateRequest(ctxWithHeaders({ "content-length": "not-a-number" })), null);
});
