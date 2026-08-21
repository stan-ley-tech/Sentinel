import assert from "node:assert/strict";
import { test } from "node:test";

import { CircuitBreaker } from "../src/routing/circuitBreaker.js";

test("starts closed and allows attempts", () => {
  const cb = new CircuitBreaker(3, 30_000);
  assert.equal(cb.state("http://a"), "closed");
  assert.equal(cb.canAttempt("http://a"), true);
});

test("stays closed after fewer failures than the threshold", () => {
  const cb = new CircuitBreaker(3, 30_000);
  cb.recordFailure("http://a");
  cb.recordFailure("http://a");
  assert.equal(cb.state("http://a"), "closed");
  assert.equal(cb.canAttempt("http://a"), true);
});

test("opens after reaching the failure threshold and blocks attempts", () => {
  const cb = new CircuitBreaker(3, 30_000);
  cb.recordFailure("http://a");
  cb.recordFailure("http://a");
  cb.recordFailure("http://a");
  assert.equal(cb.state("http://a"), "open");
  assert.equal(cb.canAttempt("http://a"), false);
});

test("a success resets the failure count and closes the breaker", () => {
  const cb = new CircuitBreaker(3, 30_000);
  cb.recordFailure("http://a");
  cb.recordFailure("http://a");
  cb.recordSuccess("http://a");
  cb.recordFailure("http://a");
  cb.recordFailure("http://a");
  // Only 2 consecutive failures since the reset (threshold is 3): still closed.
  assert.equal(cb.state("http://a"), "closed");
});

test("transitions to half-open once the reset timeout elapses, and allows one probe", () => {
  const cb = new CircuitBreaker(1, 10_000);
  const t0 = 1_000_000;
  cb.recordFailure("http://a", t0);
  assert.equal(cb.state("http://a"), "open");
  assert.equal(cb.canAttempt("http://a", t0 + 5_000), false); // still within timeout

  assert.equal(cb.canAttempt("http://a", t0 + 10_000), true); // timeout elapsed: half-open probe allowed
  assert.equal(cb.state("http://a"), "half-open");
});

test("a failed half-open probe reopens the breaker", () => {
  const cb = new CircuitBreaker(1, 10_000);
  const t0 = 1_000_000;
  cb.recordFailure("http://a", t0);
  cb.canAttempt("http://a", t0 + 10_000); // -> half-open
  cb.recordFailure("http://a", t0 + 10_100);
  assert.equal(cb.state("http://a"), "open");
});

test("a successful half-open probe closes the breaker", () => {
  const cb = new CircuitBreaker(1, 10_000);
  const t0 = 1_000_000;
  cb.recordFailure("http://a", t0);
  cb.canAttempt("http://a", t0 + 10_000); // -> half-open
  cb.recordSuccess("http://a");
  assert.equal(cb.state("http://a"), "closed");
  assert.equal(cb.canAttempt("http://a"), true);
});

test("breakers for different upstreams are independent", () => {
  const cb = new CircuitBreaker(1, 30_000);
  cb.recordFailure("http://a");
  assert.equal(cb.state("http://a"), "open");
  assert.equal(cb.state("http://b"), "closed");
  assert.equal(cb.canAttempt("http://b"), true);
});
