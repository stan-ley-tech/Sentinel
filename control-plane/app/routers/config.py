"""Read-only config snapshot the gateway polls to build (and hot-reload)
its in-memory routing, auth, and policy tables — the sole path by which
control-plane state reaches the data plane. Protected by the internal
token, not the admin token: this is a machine-to-machine credential the
gateway alone should hold, distinct from the human/CI-facing Admin API.
"""

from __future__ import annotations

import json
import sqlite3

from fastapi import APIRouter, Depends

from app.auth import require_internal
from app.db import get_db, get_jwt_secret

router = APIRouter(prefix="/internal", dependencies=[Depends(require_internal)])


@router.get("/config")
def get_config(db: sqlite3.Connection = Depends(get_db)) -> dict[str, object]:
    roles = {
        row["name"]: json.loads(row["permissions"])
        for row in db.execute("SELECT name, permissions FROM roles").fetchall()
    }

    api_keys = [
        {
            "id": row["id"],
            "key_hash": row["key_hash"],
            "role": row["role"],
            "signing_secret": row["signing_secret"],
            "enabled": bool(row["enabled"]),
            "rate_limit_per_second": row["rate_limit_per_second"],
            "rate_limit_burst": row["rate_limit_burst"],
            "quota_limit": row["quota_limit"],
            "quota_period": row["quota_period"],
        }
        for row in db.execute("SELECT * FROM api_keys").fetchall()
    ]

    routes = [
        {
            "id": row["id"],
            "path_prefix": row["path_prefix"],
            "upstreams": json.loads(row["upstreams"]),
            "strip_prefix": bool(row["strip_prefix"]),
            "auth_required": bool(row["auth_required"]),
            "required_permission": row["required_permission"],
        }
        for row in db.execute("SELECT * FROM routes").fetchall()
    ]

    ip_rules = [
        {"cidr": row["cidr"], "action": row["action"], "priority": row["priority"]}
        for row in db.execute(
            "SELECT cidr, action, priority FROM ip_rules ORDER BY priority DESC"
        ).fetchall()
    ]

    return {
        "jwt_secret": get_jwt_secret(db),
        "roles": roles,
        "api_keys": api_keys,
        "routes": routes,
        "ip_rules": ip_rules,
    }
