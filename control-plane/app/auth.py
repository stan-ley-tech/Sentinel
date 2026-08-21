"""Admin API authentication and shared secret-generation helpers."""

from __future__ import annotations

import hashlib
import os
import secrets

from fastapi import Header, HTTPException, status

ADMIN_TOKEN = os.environ.get("SENTINEL_ADMIN_TOKEN", "dev-admin-token")


def require_admin(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: require a valid `Authorization: Bearer <token>`
    header matching SENTINEL_ADMIN_TOKEN."""
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.removeprefix("Bearer ")
    if not secrets.compare_digest(token, ADMIN_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid admin token")


def new_id() -> str:
    return secrets.token_hex(16)


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
