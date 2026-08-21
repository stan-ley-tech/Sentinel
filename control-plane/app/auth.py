"""Admin API authentication and shared secret-generation helpers."""

from __future__ import annotations

import hashlib
import os
import secrets

from fastapi import Header, HTTPException, status

ADMIN_TOKEN = os.environ.get("SENTINEL_ADMIN_TOKEN", "dev-admin-token")

# Separate from ADMIN_TOKEN: only the gateway process should know this one.
# It protects /internal/* (config snapshot, audit/metrics ingest) — a
# different trust boundary than the human/CI-facing Admin API.
INTERNAL_TOKEN = os.environ.get("SENTINEL_INTERNAL_TOKEN", "dev-internal-token")


def _require_bearer_token(authorization: str | None, expected: str) -> None:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.removeprefix("Bearer ")
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bearer token")


def require_admin(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: require a valid `Authorization: Bearer <token>`
    header matching SENTINEL_ADMIN_TOKEN."""
    _require_bearer_token(authorization, ADMIN_TOKEN)


def require_internal(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: require a valid `Authorization: Bearer <token>`
    header matching SENTINEL_INTERNAL_TOKEN (used by the gateway only)."""
    _require_bearer_token(authorization, INTERNAL_TOKEN)


def new_id() -> str:
    return secrets.token_hex(16)


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
