import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidTokenError, verifyJwt } from "../src/crypto/jwt.js";

function base64Url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Local reference encoder for tests only — mirrors control-plane/app/jwt.py
 * exactly, so verifyJwt's correctness is tested independent of any real
 * issuer (the real cross-language exchange is proven in the end-to-end
 * integration test). */
function signToken(claims: Record<string, unknown>, secret: string, expiresInSeconds = 3600): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + expiresInSeconds };
  const headerB64 = base64Url(JSON.stringify(header));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  return `${headerB64}.${payloadB64}.${base64Url(sig)}`;
}

test("verifyJwt: accepts a validly signed token", () => {
  const token = signToken({ sub: "key-1", role: "reader" }, "secret");
  const payload = verifyJwt(token, "secret");
  assert.equal(payload.sub, "key-1");
  assert.equal(payload.role, "reader");
});

test("verifyJwt: rejects a token signed with a different secret", () => {
  const token = signToken({ sub: "key-1" }, "secret-a");
  assert.throws(() => verifyJwt(token, "secret-b"), InvalidTokenError);
});

test("verifyJwt: rejects a tampered payload", () => {
  const token = signToken({ sub: "key-1", role: "reader" }, "secret");
  const [headerB64, , sigB64] = token.split(".") as [string, string, string];
  const tamperedPayload = base64Url(JSON.stringify({ sub: "key-1", role: "admin" }));
  assert.throws(() => verifyJwt(`${headerB64}.${tamperedPayload}.${sigB64}`, "secret"), InvalidTokenError);
});

test("verifyJwt: rejects a malformed token", () => {
  assert.throws(() => verifyJwt("not-a-jwt", "secret"), InvalidTokenError);
});

test("verifyJwt: rejects an expired token", () => {
  const token = signToken({ sub: "key-1" }, "secret", -1);
  assert.throws(() => verifyJwt(token, "secret"), InvalidTokenError);
});
