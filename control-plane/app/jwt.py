"""Minimal hand-rolled HS256 JWT encode/decode.

Hand-rolled deliberately: the gateway (TypeScript) verifies these same
tokens with its own from-scratch HS256 implementation
(gateway/src/crypto/jwt.ts). Using one small, auditable implementation on
each side — both following RFC 7519 exactly — means there is a single,
well-understood behavior to keep in sync, rather than depending on two
third-party libraries that might disagree on some edge case.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any


class InvalidToken(Exception):
    """Raised by decode() for a malformed, tampered, or expired token."""


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def encode(claims: dict[str, Any], secret: str, *, expires_in_seconds: int = 3600) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {**claims, "iat": now, "exp": now + expires_in_seconds}

    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_b64}.{payload_b64}".encode()
    signature = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{_b64url_encode(signature)}"


def decode(token: str, secret: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidToken("malformed token")
    header_b64, payload_b64, signature_b64 = parts

    signing_input = f"{header_b64}.{payload_b64}".encode()
    expected_sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    try:
        actual_sig = _b64url_decode(signature_b64)
    except Exception as exc:
        raise InvalidToken("malformed signature") from exc
    if not hmac.compare_digest(actual_sig, expected_sig):
        raise InvalidToken("signature mismatch")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise InvalidToken("malformed payload") from exc

    if payload.get("exp", 0) < time.time():
        raise InvalidToken("token expired")
    return payload
