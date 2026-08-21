import assert from "node:assert/strict";
import { test } from "node:test";

import { RateLimiter } from "../src/pipeline/rateLimit.js";

test("RateLimiter: allows requests up to the burst capacity", () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.check("key-1", 100, 5), true);
  }
});

test("RateLimiter: rejects once the burst is exhausted", () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 3; i++) limiter.check("key-1", 100, 3);
  assert.equal(limiter.check("key-1", 100, 3), false);
});

test("RateLimiter: different keys have independent buckets", () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 3; i++) limiter.check("key-1", 100, 3);
  assert.equal(limiter.check("key-1", 100, 3), false);
  assert.equal(limiter.check("key-2", 100, 3), true);
});

test("RateLimiter: refills over time up to the burst cap", async () => {
  const limiter = new RateLimiter();
  // rate = 1000/s, burst = 1: exhaust immediately, then wait long enough
  // for at least one token to regenerate.
  assert.equal(limiter.check("key-1", 1000, 1), true);
  assert.equal(limiter.check("key-1", 1000, 1), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(limiter.check("key-1", 1000, 1), true);
});

test("RateLimiter: falls back to defaults when the key has no configured limit", () => {
  const limiter = new RateLimiter(100, 2);
  assert.equal(limiter.check("key-1", null, null), true);
  assert.equal(limiter.check("key-1", null, null), true);
  assert.equal(limiter.check("key-1", null, null), false);
});
