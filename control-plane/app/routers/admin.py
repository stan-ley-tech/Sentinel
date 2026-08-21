"""Admin API: CRUD for roles, API keys, routes, and IP allow/deny rules.

Every endpoint here requires a valid admin bearer token (see app.auth).
This is the surface that manages policy; the gateway never calls it
directly — it polls the read-only /internal/config snapshot instead
(app.routers.config), assembled from the same tables.
"""

from __future__ import annotations

import ipaddress
import json
import sqlite3
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from app import models
from app.auth import new_id, new_secret, require_admin, sha256_hex
from app.db import get_db

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- roles --

@router.post("/roles", response_model=models.RoleOut, status_code=status.HTTP_201_CREATED)
def create_role(body: models.RoleIn, db: sqlite3.Connection = Depends(get_db)) -> models.RoleOut:
    try:
        db.execute(
            "INSERT INTO roles (name, permissions) VALUES (?, ?)",
            (body.name, json.dumps(body.permissions)),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, f"role '{body.name}' already exists")
    return models.RoleOut(name=body.name, permissions=body.permissions)


@router.get("/roles", response_model=list[models.RoleOut])
def list_roles(db: sqlite3.Connection = Depends(get_db)) -> list[models.RoleOut]:
    rows = db.execute("SELECT name, permissions FROM roles ORDER BY name").fetchall()
    return [models.RoleOut(name=r["name"], permissions=json.loads(r["permissions"])) for r in rows]


@router.get("/roles/{name}", response_model=models.RoleOut)
def get_role(name: str, db: sqlite3.Connection = Depends(get_db)) -> models.RoleOut:
    row = db.execute("SELECT name, permissions FROM roles WHERE name = ?", (name,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "role not found")
    return models.RoleOut(name=row["name"], permissions=json.loads(row["permissions"]))


@router.delete("/roles/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(name: str, db: sqlite3.Connection = Depends(get_db)) -> None:
    in_use = db.execute("SELECT 1 FROM api_keys WHERE role = ? LIMIT 1", (name,)).fetchone()
    if in_use is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "role is still assigned to at least one API key")
    db.execute("DELETE FROM roles WHERE name = ?", (name,))
    db.commit()


# -------------------------------------------------------------- api keys --

def _key_row_to_out(row: sqlite3.Row) -> models.ApiKeyOut:
    return models.ApiKeyOut(
        id=row["id"],
        name=row["name"],
        role=row["role"],
        enabled=bool(row["enabled"]),
        rate_limit_per_second=row["rate_limit_per_second"],
        rate_limit_burst=row["rate_limit_burst"],
        quota_limit=row["quota_limit"],
        quota_period=row["quota_period"],
        created_at=row["created_at"],
    )


@router.post("/keys", response_model=models.ApiKeyCreated, status_code=status.HTTP_201_CREATED)
def create_key(body: models.ApiKeyIn, db: sqlite3.Connection = Depends(get_db)) -> models.ApiKeyCreated:
    role = db.execute("SELECT name FROM roles WHERE name = ?", (body.role,)).fetchone()
    if role is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown role '{body.role}'")
    if body.quota_limit is not None and body.quota_period not in ("day", "month"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "quota_period must be 'day' or 'month' when quota_limit is set")

    key_id = new_id()
    plaintext_key = new_secret()
    signing_secret = new_secret()
    created_at = _now()

    db.execute(
        """INSERT INTO api_keys
           (id, key_hash, name, role, signing_secret, rate_limit_per_second,
            rate_limit_burst, quota_limit, quota_period, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
        (key_id, sha256_hex(plaintext_key), body.name, body.role, signing_secret,
         body.rate_limit_per_second, body.rate_limit_burst, body.quota_limit,
         body.quota_period, created_at),
    )
    db.commit()

    return models.ApiKeyCreated(
        id=key_id, name=body.name, role=body.role, enabled=True,
        rate_limit_per_second=body.rate_limit_per_second,
        rate_limit_burst=body.rate_limit_burst,
        quota_limit=body.quota_limit, quota_period=body.quota_period,
        created_at=created_at, key=plaintext_key, signing_secret=signing_secret,
    )


@router.get("/keys", response_model=list[models.ApiKeyOut])
def list_keys(db: sqlite3.Connection = Depends(get_db)) -> list[models.ApiKeyOut]:
    rows = db.execute("SELECT * FROM api_keys ORDER BY created_at").fetchall()
    return [_key_row_to_out(r) for r in rows]


@router.get("/keys/{key_id}", response_model=models.ApiKeyOut)
def get_key(key_id: str, db: sqlite3.Connection = Depends(get_db)) -> models.ApiKeyOut:
    row = db.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "api key not found")
    return _key_row_to_out(row)


@router.patch("/keys/{key_id}", response_model=models.ApiKeyOut)
def update_key(key_id: str, body: models.ApiKeyUpdate, db: sqlite3.Connection = Depends(get_db)) -> models.ApiKeyOut:
    row = db.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "api key not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        return _key_row_to_out(row)

    columns = ", ".join(f"{field} = ?" for field in updates)
    db.execute(f"UPDATE api_keys SET {columns} WHERE id = ?", (*updates.values(), key_id))
    db.commit()

    updated = db.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    return _key_row_to_out(updated)


@router.delete("/keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_key(key_id: str, db: sqlite3.Connection = Depends(get_db)) -> None:
    db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
    db.commit()


# ---------------------------------------------------------------- routes --

def _route_row_to_out(row: sqlite3.Row) -> models.RouteOut:
    return models.RouteOut(
        id=row["id"],
        path_prefix=row["path_prefix"],
        upstreams=json.loads(row["upstreams"]),
        strip_prefix=bool(row["strip_prefix"]),
        auth_required=bool(row["auth_required"]),
        required_permission=row["required_permission"],
        require_signature=bool(row["require_signature"]),
        created_at=row["created_at"],
    )


def _validate_route(body: models.RouteIn) -> None:
    if not body.path_prefix.startswith("/"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "path_prefix must start with '/'")
    if not body.upstreams:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "at least one upstream is required")
    for upstream in body.upstreams:
        if not (upstream.startswith("http://") or upstream.startswith("https://")):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid upstream URL: {upstream}")
    if body.require_signature and not body.auth_required:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "require_signature routes must also require auth")


@router.post("/routes", response_model=models.RouteOut, status_code=status.HTTP_201_CREATED)
def create_route(body: models.RouteIn, db: sqlite3.Connection = Depends(get_db)) -> models.RouteOut:
    _validate_route(body)
    route_id = new_id()
    created_at = _now()
    db.execute(
        """INSERT INTO routes
           (id, path_prefix, upstreams, strip_prefix, auth_required, required_permission,
            require_signature, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (route_id, body.path_prefix, json.dumps(body.upstreams), body.strip_prefix,
         body.auth_required, body.required_permission, body.require_signature, created_at),
    )
    db.commit()
    return models.RouteOut(id=route_id, created_at=created_at, **body.model_dump())


@router.get("/routes", response_model=list[models.RouteOut])
def list_routes(db: sqlite3.Connection = Depends(get_db)) -> list[models.RouteOut]:
    rows = db.execute("SELECT * FROM routes ORDER BY path_prefix").fetchall()
    return [_route_row_to_out(r) for r in rows]


@router.get("/routes/{route_id}", response_model=models.RouteOut)
def get_route(route_id: str, db: sqlite3.Connection = Depends(get_db)) -> models.RouteOut:
    row = db.execute("SELECT * FROM routes WHERE id = ?", (route_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "route not found")
    return _route_row_to_out(row)


@router.put("/routes/{route_id}", response_model=models.RouteOut)
def update_route(route_id: str, body: models.RouteIn, db: sqlite3.Connection = Depends(get_db)) -> models.RouteOut:
    _validate_route(body)
    existing = db.execute("SELECT id, created_at FROM routes WHERE id = ?", (route_id,)).fetchone()
    if existing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "route not found")
    db.execute(
        """UPDATE routes SET path_prefix = ?, upstreams = ?, strip_prefix = ?,
           auth_required = ?, required_permission = ?, require_signature = ? WHERE id = ?""",
        (body.path_prefix, json.dumps(body.upstreams), body.strip_prefix,
         body.auth_required, body.required_permission, body.require_signature, route_id),
    )
    db.commit()
    return models.RouteOut(id=route_id, created_at=existing["created_at"], **body.model_dump())


@router.delete("/routes/{route_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_route(route_id: str, db: sqlite3.Connection = Depends(get_db)) -> None:
    db.execute("DELETE FROM routes WHERE id = ?", (route_id,))
    db.commit()


# -------------------------------------------------------------- ip rules --

def _ip_rule_row_to_out(row: sqlite3.Row) -> models.IpRuleOut:
    return models.IpRuleOut(
        id=row["id"], cidr=row["cidr"], action=row["action"],
        priority=row["priority"], created_at=row["created_at"],
    )


@router.post("/ip-rules", response_model=models.IpRuleOut, status_code=status.HTTP_201_CREATED)
def create_ip_rule(body: models.IpRuleIn, db: sqlite3.Connection = Depends(get_db)) -> models.IpRuleOut:
    if body.action not in ("allow", "deny"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "action must be 'allow' or 'deny'")
    try:
        ipaddress.ip_network(body.cidr, strict=False)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid CIDR '{body.cidr}': {exc}")

    rule_id = new_id()
    created_at = _now()
    db.execute(
        "INSERT INTO ip_rules (id, cidr, action, priority, created_at) VALUES (?, ?, ?, ?, ?)",
        (rule_id, body.cidr, body.action, body.priority, created_at),
    )
    db.commit()
    return models.IpRuleOut(id=rule_id, created_at=created_at, **body.model_dump())


@router.get("/ip-rules", response_model=list[models.IpRuleOut])
def list_ip_rules(db: sqlite3.Connection = Depends(get_db)) -> list[models.IpRuleOut]:
    rows = db.execute("SELECT * FROM ip_rules ORDER BY priority DESC, created_at").fetchall()
    return [_ip_rule_row_to_out(r) for r in rows]


@router.delete("/ip-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ip_rule(rule_id: str, db: sqlite3.Connection = Depends(get_db)) -> None:
    db.execute("DELETE FROM ip_rules WHERE id = ?", (rule_id,))
    db.commit()
