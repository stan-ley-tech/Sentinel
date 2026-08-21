"""Live HTML dashboard: current API keys/routes/IP rules, the latest
metrics snapshot pushed by the gateway, and recent audit log entries.
Protected by HTTP Basic auth so a browser can log in with a native
prompt instead of needing a custom header.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.auth import require_admin_basic
from app.db import get_db

router = APIRouter(dependencies=[Depends(require_admin_basic)])

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request, db: sqlite3.Connection = Depends(get_db)) -> HTMLResponse:
    keys = db.execute("SELECT * FROM api_keys ORDER BY created_at").fetchall()
    routes = db.execute("SELECT * FROM routes ORDER BY path_prefix").fetchall()
    ip_rules = db.execute("SELECT * FROM ip_rules ORDER BY priority DESC").fetchall()
    audit_rows = db.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 50").fetchall()

    metrics_row = db.execute("SELECT value FROM settings WHERE key = 'latest_metrics'").fetchone()
    metrics = json.loads(metrics_row["value"]) if metrics_row is not None else None

    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "keys": keys,
            "routes": routes,
            "ip_rules": ip_rules,
            "audit_rows": audit_rows,
            "metrics": metrics,
        },
    )
