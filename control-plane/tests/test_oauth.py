from fastapi.testclient import TestClient

from app import jwt as sentinel_jwt
from app.db import get_jwt_secret


def _create_role_and_key(client: TestClient, admin_headers: dict[str, str]) -> dict[str, str]:
    client.post("/admin/roles", json={"name": "reader", "permissions": ["orders:read"]}, headers=admin_headers)
    resp = client.post("/admin/keys", json={"name": "app-1", "role": "reader"}, headers=admin_headers)
    return resp.json()


def test_client_credentials_issues_valid_token(client: TestClient, admin_headers: dict[str, str], db_conn) -> None:
    key = _create_role_and_key(client, admin_headers)

    resp = client.post(
        "/oauth/token",
        data={"grant_type": "client_credentials", "client_id": key["id"], "client_secret": key["key"]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 3600

    secret = get_jwt_secret(db_conn)
    payload = sentinel_jwt.decode(body["access_token"], secret)
    assert payload["sub"] == key["id"]
    assert payload["role"] == "reader"


def test_rejects_unsupported_grant_type(client: TestClient, admin_headers: dict[str, str]) -> None:
    key = _create_role_and_key(client, admin_headers)
    resp = client.post(
        "/oauth/token",
        data={"grant_type": "password", "client_id": key["id"], "client_secret": key["key"]},
    )
    assert resp.status_code == 400


def test_rejects_wrong_client_secret(client: TestClient, admin_headers: dict[str, str]) -> None:
    key = _create_role_and_key(client, admin_headers)
    resp = client.post(
        "/oauth/token",
        data={"grant_type": "client_credentials", "client_id": key["id"], "client_secret": "wrong"},
    )
    assert resp.status_code == 401


def test_rejects_unknown_client_id(client: TestClient) -> None:
    resp = client.post(
        "/oauth/token",
        data={"grant_type": "client_credentials", "client_id": "does-not-exist", "client_secret": "whatever"},
    )
    assert resp.status_code == 401


def test_rejects_disabled_key(client: TestClient, admin_headers: dict[str, str]) -> None:
    key = _create_role_and_key(client, admin_headers)
    client.patch(f"/admin/keys/{key['id']}", json={"enabled": False}, headers=admin_headers)

    resp = client.post(
        "/oauth/token",
        data={"grant_type": "client_credentials", "client_id": key["id"], "client_secret": key["key"]},
    )
    assert resp.status_code == 401
