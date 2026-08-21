# Sentinel Architecture

Sentinel is an API gateway: a reverse proxy that sits in front of backend
services and enforces authentication, authorization, rate limiting,
quotas, and other security policy on every request before it's allowed
through.

```
Internet
   ↓
 Sentinel (gateway, TypeScript)
   ├── IP allow/deny
   ├── Auth (API key / JWT / OAuth bearer)
   ├── Authorization (RBAC)
   ├── Request validation, signing, replay protection
   ├── Rate limiting + quotas
   ├── Routing + versioning (round-robin over healthy upstreams)
   ├── Circuit breaker + health checks
   └── Observability (metrics + audit log) ──→ Control plane (Python)
                          ↓                         ├── Admin API (keys/routes/roles/quotas/IP rules)
                       Services                      ├── OAuth token issuance
                                                      ├── Config snapshot (gateway polls & hot-reloads)
                                                      ├── Audit/metrics ingest
                                                      └── Dashboard (HTML)
```

## Why two languages, two roles

**The gateway is the data plane** — the hot path every single request goes
through. It's TypeScript/Node.js because an event-loop-based server is a
natural fit for a proxy that's mostly juggling concurrent I/O (client
socket, upstream socket) rather than doing heavy computation, and because
Node's `http`/`crypto`/`net` modules are enough to build a real reverse
proxy, JWT/HMAC verification, and CIDR matching from scratch — zero
runtime npm dependencies (only `typescript`/`@types/node` as dev
dependencies).

**The control plane is where policy lives** — the Admin API, the
dashboard, and OAuth token issuance. Python/FastAPI is the fast-to-build-
correctly choice for a CRUD-heavy admin surface with auto-generated
OpenAPI docs, and it's also where the benchmark's load generator lives
(`aiohttp` is genuinely the right tool for concurrent async load
generation, not a language-choice afterthought).

**The two only ever talk over plain HTTP** — no shared database file, no
cross-language driver. Config flows one direction (control plane → gateway,
polled and hot-reloaded, no gateway restart needed); telemetry flows the
other (gateway → control plane, audit log entries and metric snapshots,
best-effort). This mirrors a real control-plane/data-plane split (the same
shape as Envoy's xDS or Kubernetes' controller/data-plane model) and means
either side can be deployed, restarted, or scaled independently.

## The gateway's request pipeline

Every request that matches a configured route runs through an ordered
chain of stages (`gateway/src/pipeline/pipeline.ts`), each of which can
either pass the request along or reject it outright:

1. **IP filter** — IPv4 CIDR allow/deny. A matching deny rule always wins;
   with no allow rules configured, traffic is allowed by default
   (deny-list-only is the common case).
2. **Auth** — `X-Api-Key` (hashed and matched against the current config)
   or `Authorization: Bearer <JWT>` (verified with a hand-rolled HS256
   implementation). A JWT's role is always re-resolved against the
   *current* config by the token's subject id, never trusted from the
   token's own claim — so revoking or changing a key's role takes effect
   immediately, even for already-issued tokens.
3. **Rate limit** and **quota** — checked immediately after identity is
   established, before any more expensive work (permission lookups,
   signature verification) is spent on a caller who's already over
   budget. Rate limiting is a per-key token bucket (falls back to a
   global default when a key has no override); quotas are independent
   daily/monthly caps for a much longer window.
4. **Authorize (RBAC)** — a route's required permission (if any) must
   appear in the caller's role's permission list, or the role holds the
   `*` wildcard.
5. **Validate** — request size limit, checked against `Content-Length`
   so it costs nothing on the common path.
6. **Signing** and **replay protection** — only for routes with
   `require_signature` set. `X-Signature` (HMAC-SHA256 over
   `timestamp.nonce.body`, using the caller's per-key signing secret),
   `X-Signature-Timestamp` (rejected outside a 5-minute clock-skew
   window), and `X-Nonce` (tracked per key for that same window; a
   nonce is only ever recorded *after* its signature verifies, so a bad
   signature can't be used to burn a victim's nonces as a denial-of-
   service). These are the only stages that read the request body into
   memory — every other route stays a pure stream straight through to
   the upstream, which is what keeps the common case fast (see
   [BENCHMARK.md](BENCHMARK.md)).
7. **Route + proxy** — longest-prefix-match picks the most specific
   route, round-robins over whichever of its upstreams are currently
   healthy *and* not circuit-broken, and streams the request through
   (`node:http`/`node:https`, no proxy dependency).

A rejection at any stage carries a `stage` tag (`ip_filter`, `auth`,
`rate_limit`, `quota`, `authorize`, `validate`, `signing`, `replay`) that
flows straight into both the metrics registry (rejections-by-stage) and
the audit log entry — the dashboard shows *why* traffic was rejected, not
just that it was.

## Resilience: circuit breakers and health checks

Each upstream has its own circuit breaker (closed → open after N
consecutive failures → half-open probe once a reset timeout elapses →
closed again on success, or open again on failure) and is independently
health-checked (`GET <upstream>/healthz` on a timer; optimistically
healthy until the first check completes, so a brand-new upstream isn't
excluded before it's ever been probed). A proxied request's outcome feeds
the breaker directly: a 5xx response or a connection error counts as a
failure, anything else as a success. `router.pickUpstream` only considers
upstreams that are both health-check-healthy *and* not circuit-open.

The failure threshold, reset timeout, and health-check interval are all
environment-configurable (`SENTINEL_BREAKER_FAILURE_THRESHOLD`,
`SENTINEL_BREAKER_RESET_MS`, `SENTINEL_HEALTH_CHECK_INTERVAL_MS`) —
useful for production tuning, and what lets the integration test and
benchmark observe a full trip-and-recover cycle in seconds instead of the
30-second production default.

## Configuration distribution

The control plane is the single source of truth for roles, API keys,
routes, and IP rules (SQLite, stdlib `sqlite3`). `GET /internal/config`
(protected by a separate internal token — a distinct trust boundary from
the human/CI-facing Admin API) returns the full current policy as one
snapshot, including each key's signing secret (needed in plaintext for
HMAC verification — there's no way around a verifier needing a shared
secret) and the shared HS256 secret used for OAuth-issued JWTs (generated
once, persisted, so it survives control-plane restarts without any manual
coordination). The gateway polls this on an interval and atomically
swaps in the new config — no restart, no dropped connections.

## Observability

`gateway/src/observability/`: an in-process metrics registry (requests by
route+status, average latency by route, rejections by stage, live
upstream health/circuit state) exposed as Prometheus text at `/metrics`
and pushed as a JSON snapshot to the control plane; and an audit logger
that records one structured entry per request, always to stdout and
best-effort batched to the control plane. A control-plane outage drops
forwarding rather than growing memory without bound — stdout is the
durable record for that window. The control plane's `/dashboard` (HTTP
Basic auth, the admin token as the password, so a browser can log in with
a native prompt) renders all of this live, auto-refreshing every 5s.

## Trade-offs and limitations

- **Single-process gateway.** No clustering/worker-process model — one
  Node.js event loop, one CPU core. [BENCHMARK.md](BENCHMARK.md) reports
  what that one process actually sustains rather than a theoretical
  multi-core figure.
- **IPv4-only CIDR matching.** Hand-rolled deliberately (minimal
  dependencies); IPv6 would be a real but bounded extension.
- **Whole-request signing, not per-field.** Matches how most real HMAC
  request-signing schemes work (Stripe/AWS-style), but means any change
  to the body invalidates the signature, not just a change to a specific
  field.
- **In-memory rate limiting, quotas, and replay tracking.** State resets
  on gateway restart and doesn't share across multiple gateway
  instances. A multi-instance deployment would need a shared store
  (Redis, etc.) for these — a natural extension point, not built here.
- **Metrics/audit are best-effort push, not guaranteed delivery.** Fine
  for a dashboard; a compliance-grade audit trail would want at-least-
  once delivery with retry/persistence on the gateway side.
