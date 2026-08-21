import time

import pytest

from app import jwt as sentinel_jwt


def test_encode_decode_round_trip() -> None:
    token = sentinel_jwt.encode({"sub": "key-1", "role": "reader"}, "secret")
    payload = sentinel_jwt.decode(token, "secret")
    assert payload["sub"] == "key-1"
    assert payload["role"] == "reader"
    assert "iat" in payload and "exp" in payload


def test_decode_rejects_wrong_secret() -> None:
    token = sentinel_jwt.encode({"sub": "key-1"}, "secret-a")
    with pytest.raises(sentinel_jwt.InvalidToken):
        sentinel_jwt.decode(token, "secret-b")


def test_decode_rejects_tampered_payload() -> None:
    token = sentinel_jwt.encode({"sub": "key-1", "role": "reader"}, "secret")
    header_b64, payload_b64, sig_b64 = token.split(".")

    tampered_payload = sentinel_jwt._b64url_encode(b'{"sub":"key-1","role":"admin"}')
    tampered_token = f"{header_b64}.{tampered_payload}.{sig_b64}"

    with pytest.raises(sentinel_jwt.InvalidToken):
        sentinel_jwt.decode(tampered_token, "secret")


def test_decode_rejects_malformed_token() -> None:
    with pytest.raises(sentinel_jwt.InvalidToken):
        sentinel_jwt.decode("not-a-jwt", "secret")


def test_decode_rejects_expired_token() -> None:
    token = sentinel_jwt.encode({"sub": "key-1"}, "secret", expires_in_seconds=-1)
    with pytest.raises(sentinel_jwt.InvalidToken):
        sentinel_jwt.decode(token, "secret")


def test_expires_in_seconds_sets_exp_relative_to_now() -> None:
    before = int(time.time())
    token = sentinel_jwt.encode({"sub": "key-1"}, "secret", expires_in_seconds=60)
    payload = sentinel_jwt.decode(token, "secret")
    assert before + 60 <= payload["exp"] <= before + 61
