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

Two languages, split by role: the **gateway** (TypeScript/Node.js) is the
data plane — the hot request path every call goes through. The **control
plane** (Python/FastAPI) owns configuration, the admin API, the dashboard,
and the benchmark tooling. The gateway polls the control plane for config
and hot-reloads without restarting; it reports audit logs and metrics back.

> Status: under active development. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design details as they
> land.

## Features

- [ ] Reverse proxy
- [ ] API routing
- [ ] API key management
- [ ] JWT validation
- [ ] OAuth support
- [ ] Role-based authorization
- [ ] Rate limiting
- [ ] Request quotas
- [ ] IP allow/deny rules
- [ ] Request validation
- [ ] API versioning
- [ ] Request signing
- [ ] Replay protection
- [ ] Audit logs
- [ ] Traffic metrics
- [ ] Circuit breakers
- [ ] Service health checks
- [ ] Configuration management
- [ ] Admin API
- [ ] Dashboard
- [ ] Load-test benchmark with documented throughput/latency/failure behavior

## Layout

```
gateway/          TypeScript data plane (reverse proxy + security pipeline)
control-plane/    Python control plane (admin API, dashboard, config)
services/         minimal demo upstream services to proxy to
benchmark/        asyncio/aiohttp load generator
docs/             architecture, API reference, benchmark results
```

## License

[MIT](LICENSE)
