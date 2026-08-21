"""Ingest endpoints the gateway pushes to: audit log entries and periodic
metrics snapshots. Protected by the internal token — same trust boundary
as /internal/config. Bodies are accepted as loosely-typed JSON (rather
than strict pydantic models): the gateway's TypeScript types are the
source of truth for this shape (camelCase field names), and this endpoint
just needs to store it for the dashboard to render, not deeply validate
it.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends

from app.auth import require_internal
from app.db import MAX_AUDIT_LOG_ROWS, get_db

router = APIRouter(prefix="/internal", dependencies=[Depends(require_internal)])


@router.post("/audit")
def ingest_audit(body: dict[str, Any], db: sqlite3.Connection = Depends(get_db)) -> dict[str, int]:
    entries = body.get("entries", [])
    for e in entries:
        db.execute(
            """INSERT INTO audit_log
               (timestamp, method, path, client_ip, api_key_id, role, route_id,
                allowed, stage, status_code, duration_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                e.get("timestamp"), e.get("method"), e.get("path"), e.get("clientIp"),
                e.get("apiKeyId"), e.get("role"), e.get("routeId"),
                bool(e.get("allowed")), e.get("stage"), e.get("statusCode"), e.get("durationMs"),
            ),
        )
    db.commit()
    db.execute(
        "DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)",
        (MAX_AUDIT_LOG_ROWS,),
    )
    db.commit()
    return {"accepted": len(entries)}


@router.post("/metrics")
def ingest_metrics(body: dict[str, Any], db: sqlite3.Connection = Depends(get_db)) -> dict[str, str]:
    db.execute(
        """INSERT INTO settings (key, value) VALUES ('latest_metrics', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
        (json.dumps(body),),
    )
    db.commit()
    return {"status": "ok"}
