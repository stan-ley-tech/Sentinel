"""OAuth2 client_credentials token issuance.

API keys double as OAuth clients: client_id is the key's id and
client_secret is the same plaintext key used for X-API-Key header auth.
This gives every caller a choice of two equivalent auth methods against
the same identity/role — a static header for simple service-to-service
calls, or a short-lived bearer JWT for anything that wants tokens with an
expiry. The gateway's auth stage (pipeline/auth.ts) accepts either.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Form, HTTPException, status

from app import jwt as sentinel_jwt
from app.auth import sha256_hex
from app.db import get_db, get_jwt_secret

router = APIRouter(prefix="/oauth")

TOKEN_TTL_SECONDS = 3600


@router.post("/token")
def issue_token(
    grant_type: str = Form(...),
    client_id: str = Form(...),
    client_secret: str = Form(...),
    db: sqlite3.Connection = Depends(get_db),
) -> dict[str, object]:
    if grant_type != "client_credentials":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unsupported_grant_type")

    row = db.execute("SELECT * FROM api_keys WHERE id = ?", (client_id,)).fetchone()
    if row is None or not row["enabled"] or sha256_hex(client_secret) != row["key_hash"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_client")

    secret = get_jwt_secret(db)
    token = sentinel_jwt.encode(
        {"sub": row["id"], "role": row["role"]}, secret, expires_in_seconds=TOKEN_TTL_SECONDS
    )
    return {"access_token": token, "token_type": "bearer", "expires_in": TOKEN_TTL_SECONDS}
