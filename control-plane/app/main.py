"""Sentinel control plane: admin API, config distribution, and dashboard.

The gateway (TypeScript, in ../gateway) is the data plane that enforces
policy on every request; this service is the control plane that owns the
policy itself — API keys, routes, roles, quotas, IP rules — and hands it to
the gateway over HTTP.
"""

from fastapi import FastAPI

from app.routers import admin, config, dashboard, ingest, oauth

app = FastAPI(title="Sentinel Control Plane")

app.include_router(admin.router)
app.include_router(oauth.router)
app.include_router(config.router)
app.include_router(ingest.router)
app.include_router(dashboard.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
