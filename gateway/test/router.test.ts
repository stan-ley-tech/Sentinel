import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayConfig, RouteConfig } from "../src/config/types.js";
import { Router } from "../src/routing/router.js";

function makeRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: "route-1",
    pathPrefix: "/v1/orders",
    upstreams: ["http://upstream-a", "http://upstream-b"],
    stripPrefix: false,
    authRequired: true,
    requiredPermission: null,
    ...overrides,
  };
}

function configWith(routes: RouteConfig[]): GatewayConfig {
  return { jwtSecret: "s", roles: {}, apiKeys: [], routes, ipRules: [] };
}

test("match: exact prefix matches", () => {
  const route = makeRoute();
  const router = new Router(() => configWith([route]));
  assert.equal(router.match("/v1/orders"), route);
});

test("match: sub-path matches", () => {
  const route = makeRoute();
  const router = new Router(() => configWith([route]));
  assert.equal(router.match("/v1/orders/123"), route);
});

test("match: does not match a different path merely sharing a prefix string", () => {
  const route = makeRoute();
  const router = new Router(() => configWith([route]));
  assert.equal(router.match("/v1/orders-extra"), null);
});

test("match: no route matches an unrelated path", () => {
  const router = new Router(() => configWith([makeRoute()]));
  assert.equal(router.match("/v2/users"), null);
});

test("match: picks the longest (most specific) matching prefix", () => {
  const general = makeRoute({ id: "general", pathPrefix: "/v1" });
  const specific = makeRoute({ id: "specific", pathPrefix: "/v1/orders" });
  const router = new Router(() => configWith([general, specific]));
  assert.equal(router.match("/v1/orders/123")?.id, "specific");
  assert.equal(router.match("/v1/users")?.id, "general");
});

test("pickUpstream: round-robins across healthy upstreams", () => {
  const route = makeRoute({ upstreams: ["http://a", "http://b"] });
  const router = new Router(() => configWith([route]));
  const picks = [router.pickUpstream(route), router.pickUpstream(route), router.pickUpstream(route)];
  assert.deepEqual(picks, ["http://a", "http://b", "http://a"]);
});

test("pickUpstream: skips unhealthy upstreams", () => {
  const route = makeRoute({ upstreams: ["http://a", "http://b"] });
  const router = new Router(() => configWith([route]), (u) => u === "http://b");
  assert.equal(router.pickUpstream(route), "http://b");
  assert.equal(router.pickUpstream(route), "http://b");
});

test("pickUpstream: returns null when no upstream is healthy", () => {
  const route = makeRoute();
  const router = new Router(() => configWith([route]), () => false);
  assert.equal(router.pickUpstream(route), null);
});

test("buildForwardPath: no strip keeps full path and query", () => {
  const route = makeRoute({ stripPrefix: false });
  const router = new Router(() => configWith([route]));
  assert.equal(router.buildForwardPath(route, "/v1/orders/123", "?a=1"), "/v1/orders/123?a=1");
});

test("buildForwardPath: strip removes the matched prefix", () => {
  const route = makeRoute({ stripPrefix: true, pathPrefix: "/v1/orders" });
  const router = new Router(() => configWith([route]));
  assert.equal(router.buildForwardPath(route, "/v1/orders/123", ""), "/123");
});

test("buildForwardPath: strip on an exact prefix match forwards root", () => {
  const route = makeRoute({ stripPrefix: true, pathPrefix: "/v1/orders" });
  const router = new Router(() => configWith([route]));
  assert.equal(router.buildForwardPath(route, "/v1/orders", "?x=1"), "/?x=1");
});
