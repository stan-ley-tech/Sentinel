import assert from "node:assert/strict";
import { test } from "node:test";

import { checkIpRules } from "../src/pipeline/ipFilter.js";

test("no rules: allows everything", () => {
  assert.equal(checkIpRules("203.0.113.5", []), null);
});

test("deny rule matching the client IP rejects", () => {
  const rejection = checkIpRules("10.0.0.5", [{ cidr: "10.0.0.0/8", action: "deny", priority: 0 }]);
  assert.notEqual(rejection, null);
  assert.equal(rejection?.statusCode, 403);
});

test("deny rule not matching the client IP does not reject", () => {
  assert.equal(checkIpRules("203.0.113.5", [{ cidr: "10.0.0.0/8", action: "deny", priority: 0 }]), null);
});

test("allow-list configured: non-matching IP is rejected", () => {
  const rejection = checkIpRules("203.0.113.5", [{ cidr: "192.168.0.0/16", action: "allow", priority: 0 }]);
  assert.notEqual(rejection, null);
  assert.equal(rejection?.statusCode, 403);
});

test("allow-list configured: matching IP passes", () => {
  assert.equal(checkIpRules("192.168.1.5", [{ cidr: "192.168.0.0/16", action: "allow", priority: 0 }]), null);
});

test("deny takes precedence over a broader allow", () => {
  const rules = [
    { cidr: "10.0.0.0/8", action: "allow" as const, priority: 0 },
    { cidr: "10.0.0.5/32", action: "deny" as const, priority: 10 },
  ];
  const rejection = checkIpRules("10.0.0.5", rules);
  assert.notEqual(rejection, null);
  assert.equal(rejection?.statusCode, 403);
});

test("exact /32 CIDR matches only that address", () => {
  const rule = { cidr: "10.0.0.5/32", action: "deny" as const, priority: 0 };
  assert.notEqual(checkIpRules("10.0.0.5", [rule]), null);
  assert.equal(checkIpRules("10.0.0.6", [rule]), null);
});

test("0.0.0.0/0 matches any address", () => {
  const rule = { cidr: "0.0.0.0/0", action: "deny" as const, priority: 0 };
  assert.notEqual(checkIpRules("203.0.113.5", [rule]), null);
});

test("a malformed client IP never matches a CIDR (fails closed on allow-lists)", () => {
  const rejection = checkIpRules("not-an-ip", [{ cidr: "10.0.0.0/8", action: "allow", priority: 0 }]);
  assert.notEqual(rejection, null);
});
