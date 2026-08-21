import assert from "node:assert/strict";
import { test } from "node:test";

import { MetricsRegistry } from "../src/observability/metrics.js";

test("snapshot: aggregates request counts by route and status", () => {
  const m = new MetricsRegistry();
  m.recordRequest("r1", 200, 10);
  m.recordRequest("r1", 200, 20);
  m.recordRequest("r1", 500, 30);

  const snap = m.snapshot();
  const ok = snap.requests.find((r) => r.route === "r1" && r.status === 200);
  const err = snap.requests.find((r) => r.route === "r1" && r.status === 500);
  assert.equal(ok?.count, 2);
  assert.equal(err?.count, 1);
});

test("snapshot: computes average latency per route", () => {
  const m = new MetricsRegistry();
  m.recordRequest("r1", 200, 10);
  m.recordRequest("r1", 200, 30);

  const snap = m.snapshot();
  assert.equal(snap.avgLatencyMs.find((r) => r.route === "r1")?.avgMs, 20);
});

test("snapshot: aggregates rejections by stage", () => {
  const m = new MetricsRegistry();
  m.recordRejection("auth");
  m.recordRejection("auth");
  m.recordRejection("rate_limit");

  const snap = m.snapshot();
  assert.equal(snap.rejections.find((r) => r.stage === "auth")?.count, 2);
  assert.equal(snap.rejections.find((r) => r.stage === "rate_limit")?.count, 1);
});

test("snapshot: carries through upstream statuses unchanged", () => {
  const m = new MetricsRegistry();
  const upstreams = [{ upstream: "http://a", healthy: true, circuitState: "closed" as const }];
  assert.deepEqual(m.snapshot(upstreams).upstreams, upstreams);
});

test("toPrometheusText: renders counters, gauges, and upstream status lines", () => {
  const m = new MetricsRegistry();
  m.recordRequest("r1", 200, 15);
  m.recordRejection("auth");

  const text = m.toPrometheusText([{ upstream: "http://a", healthy: false, circuitState: "open" }]);
  assert.match(text, /sentinel_requests_total\{route="r1",status="200"\} 1/);
  assert.match(text, /sentinel_request_duration_ms_avg\{route="r1"\} 15/);
  assert.match(text, /sentinel_rejections_total\{stage="auth"\} 1/);
  assert.match(text, /sentinel_upstream_healthy\{upstream="http:\/\/a"\} 0/);
  assert.match(text, /sentinel_circuit_breaker_open\{upstream="http:\/\/a"\} 1/);
});

test("toPrometheusText: is valid even with no data recorded yet", () => {
  const m = new MetricsRegistry();
  const text = m.toPrometheusText();
  assert.match(text, /# HELP sentinel_requests_total/);
});
