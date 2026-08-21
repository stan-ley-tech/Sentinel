# Sentinel

**API Security & Traffic Gateway.** A reverse proxy that enforces
authentication, authorization, rate limiting, quotas, and security policy
in front of backend services — with a control plane to manage it and a
documented load-test benchmark to prove it holds up.

```
Internet
   ↓
 Sentinel
   ├── Auth
   ├── Rate Limit
   ├── Authorization
   ├── Security
   ├── Routing
   └── Observability
          ↓
       Services
```

Two languages, split by role: the **gateway** (TypeScript/Node.js, zero
runtime npm dependencies) is the data plane — the hot request path every
call goes through. The **control plane** (Python/FastAPI) owns
configuration, the admin API, the dashboard, and the benchmark tooling.
The gateway polls the control plane for config and hot-reloads without
restarting; it reports audit logs and metrics back. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Quickstart

Requires Node.js 20+ and Python 3.11+.

```sh
# 1. Control plane
cd control-plane
python -m venv .venv
./.venv/Scripts/pip install -r requirements-dev.txt   # .venv/bin/pip on macOS/Linux
./.venv/Scripts/python -m pytest                       # 60 tests
./.venv/Scripts/python -m uvicorn app.main:app --port 8000 &

# 2. Gateway
cd ../gateway
npm install
npm run build
npm test                                               # 123 tests
SENTINEL_CONTROL_PLANE_URL=http://127.0.0.1:8000 node dist/src/index.js &

# 3. A demo backend to proxy to
cd ../services
../control-plane/.venv/Scripts/python orders_service.py 9001 &

# 4. Wire up a route + key through the real Admin API
curl -X POST http://127.0.0.1:8000/admin/roles \
  -H "Authorization: Bearer dev-admin-token" -H "Content-Type: application/json" \
  -d '{"name":"reader","permissions":["orders:read"]}'
curl -X POST http://127.0.0.1:8000/admin/routes \
  -H "Authorization: Bearer dev-admin-token" -H "Content-Type: application/json" \
  -d '{"path_prefix":"/orders","upstreams":["http://127.0.0.1:9001"],"auth_required":true,"required_permission":"orders:read"}'
KEY=$(curl -s -X POST http://127.0.0.1:8000/admin/keys \
  -H "Authorization: Bearer dev-admin-token" -H "Content-Type: application/json" \
  -d '{"name":"demo","role":"reader"}' | python -c "import sys,json;print(json.load(sys.stdin)['key'])")

# 5. Traffic through the gateway (wait a couple seconds for the first config poll)
curl http://127.0.0.1:8080/orders -H "X-Api-Key: $KEY"

# 6. The dashboard
open http://127.0.0.1:8000/dashboard   # Basic auth: any username, "dev-admin-token" as password
```

Or skip the manual wiring and run the full proof/benchmark directly:

```sh
# Real end-to-end proof: starts everything, exercises auth/RBAC/OAuth/
# rate limiting/signing/replay/circuit-breaker recovery over real HTTP.
python test/integration/run_e2e.py

# Real load test against the real running stack — see docs/BENCHMARK.md
# for a captured run's numbers.
./control-plane/.venv/Scripts/pip install -r benchmark/requirements.txt
python benchmark/run_benchmark.py
```

## Features

- [x] Reverse proxy
- [x] API routing
- [x] API key management
- [x] JWT validation
- [x] OAuth support (`client_credentials`)
- [x] Role-based authorization
- [x] Rate limiting
- [x] Request quotas
- [x] IP allow/deny rules
- [x] Request validation
- [x] API versioning (path-based; independent routes per version prefix)
- [x] Request signing (HMAC)
- [x] Replay protection
- [x] Audit logs
- [x] Traffic metrics (Prometheus text + live dashboard)
- [x] Circuit breakers
- [x] Service health checks
- [x] Configuration management (poll + hot-reload, no restart)
- [x] Admin API
- [x] Dashboard
- [x] Load-test benchmark with documented throughput/latency/failure behavior

## Layout

```
gateway/          TypeScript data plane (reverse proxy + security pipeline)
control-plane/    Python control plane (admin API, dashboard, config)
services/         minimal demo upstream services to proxy to
benchmark/        asyncio/aiohttp load generator
test/integration/ real end-to-end proof (all processes, real HTTP)
docs/             architecture, API reference, benchmark results
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, the request
  pipeline, resilience mechanics, trade-offs
- [docs/API.md](docs/API.md) — full REST reference (Admin API, OAuth,
  internal endpoints, and the headers a client sends through the gateway)
- [docs/BENCHMARK.md](docs/BENCHMARK.md) — real captured throughput/
  latency/failure numbers

## License

[MIT](LICENSE)
