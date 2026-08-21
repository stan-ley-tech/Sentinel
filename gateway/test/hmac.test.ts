import assert from "node:assert/strict";
import { test } from "node:test";

import { computeSignature, verifySignature } from "../src/crypto/hmac.js";

test("verifySignature: accepts a correctly computed signature", () => {
  const body = Buffer.from('{"amount":100}');
  const sig = computeSignature("secret", "1700000000000", "nonce-1", body);
  assert.equal(verifySignature("secret", "1700000000000", "nonce-1", body, sig), true);
});

test("verifySignature: rejects a wrong secret", () => {
  const body = Buffer.from("payload");
  const sig = computeSignature("secret-a", "1700000000000", "nonce-1", body);
  assert.equal(verifySignature("secret-b", "1700000000000", "nonce-1", body, sig), false);
});

test("verifySignature: rejects a tampered body", () => {
  const sig = computeSignature("secret", "1700000000000", "nonce-1", Buffer.from("original"));
  assert.equal(verifySignature("secret", "1700000000000", "nonce-1", Buffer.from("tampered"), sig), false);
});

test("verifySignature: rejects a mismatched nonce", () => {
  const body = Buffer.from("payload");
  const sig = computeSignature("secret", "1700000000000", "nonce-1", body);
  assert.equal(verifySignature("secret", "1700000000000", "nonce-2", body, sig), false);
});

test("verifySignature: rejects a malformed (non-hex) signature", () => {
  const body = Buffer.from("payload");
  assert.equal(verifySignature("secret", "1700000000000", "nonce-1", body, "not-hex!!"), false);
});
