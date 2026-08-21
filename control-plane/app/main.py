"""Sentinel control plane: admin API, config distribution, and dashboard.

The gateway (TypeScript, in ../gateway) is the data plane that enforces
policy on every request; this service is the control plane that owns the
policy itself — API keys, routes, roles, quotas, IP rules — and hands it to
the gateway over HTTP.
"""

from fastapi import FastAPI

app = FastAPI(title="Sentinel Control Plane")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
