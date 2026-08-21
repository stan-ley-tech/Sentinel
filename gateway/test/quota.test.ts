import assert from "node:assert/strict";
import { test } from "node:test";

import { QuotaTracker } from "../src/pipeline/quota.js";

test("QuotaTracker: allows requests up to the limit", () => {
  const tracker = new QuotaTracker();
  const now = new Date("2026-01-15T12:00:00Z");
  for (let i = 0; i < 3; i++) {
    assert.equal(tracker.checkAndIncrement("key-1", 3, "day", now), true);
  }
});

test("QuotaTracker: rejects once the limit is reached", () => {
  const tracker = new QuotaTracker();
  const now = new Date("2026-01-15T12:00:00Z");
  for (let i = 0; i < 3; i++) tracker.checkAndIncrement("key-1", 3, "day", now);
  assert.equal(tracker.checkAndIncrement("key-1", 3, "day", now), false);
});

test("QuotaTracker: resets when a new day begins", () => {
  const tracker = new QuotaTracker();
  const day1 = new Date("2026-01-15T23:59:00Z");
  const day2 = new Date("2026-01-16T00:01:00Z");
  for (let i = 0; i < 3; i++) tracker.checkAndIncrement("key-1", 3, "day", day1);
  assert.equal(tracker.checkAndIncrement("key-1", 3, "day", day1), false);
  assert.equal(tracker.checkAndIncrement("key-1", 3, "day", day2), true);
});

test("QuotaTracker: does not reset within the same day", () => {
  const tracker = new QuotaTracker();
  const morning = new Date("2026-01-15T01:00:00Z");
  const evening = new Date("2026-01-15T23:00:00Z");
  for (let i = 0; i < 3; i++) tracker.checkAndIncrement("key-1", 3, "day", morning);
  assert.equal(tracker.checkAndIncrement("key-1", 3, "day", evening), false);
});

test("QuotaTracker: resets when a new month begins", () => {
  const tracker = new QuotaTracker();
  const janEnd = new Date("2026-01-31T12:00:00Z");
  const febStart = new Date("2026-02-01T00:00:01Z");
  for (let i = 0; i < 2; i++) tracker.checkAndIncrement("key-1", 2, "month", janEnd);
  assert.equal(tracker.checkAndIncrement("key-1", 2, "month", janEnd), false);
  assert.equal(tracker.checkAndIncrement("key-1", 2, "month", febStart), true);
});

test("QuotaTracker: usage reports the current period's count", () => {
  const tracker = new QuotaTracker();
  const now = new Date("2026-01-15T12:00:00Z");
  tracker.checkAndIncrement("key-1", 10, "day", now);
  tracker.checkAndIncrement("key-1", 10, "day", now);
  assert.equal(tracker.usage("key-1"), 2);
});

test("QuotaTracker: different keys are tracked independently", () => {
  const tracker = new QuotaTracker();
  const now = new Date("2026-01-15T12:00:00Z");
  tracker.checkAndIncrement("key-1", 1, "day", now);
  assert.equal(tracker.checkAndIncrement("key-1", 1, "day", now), false);
  assert.equal(tracker.checkAndIncrement("key-2", 1, "day", now), true);
});
