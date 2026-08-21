from fastapi.testclient import TestClient


def _create_role(client: TestClient, headers: dict[str, str], name: str = "reader") -> None:
    resp = client.post("/admin/roles", json={"name": name, "permissions": ["orders:read"]}, headers=headers)
    assert resp.status_code == 201


def test_create_key_requires_known_role(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.post("/admin/keys", json={"name": "app-1", "role": "no-such-role"}, headers=admin_headers)
    assert resp.status_code == 400


def test_create_key_returns_plaintext_secret_once(client: TestClient, admin_headers: dict[str, str]) -> None:
    _create_role(client, admin_headers)
    resp = client.post("/admin/keys", json={"name": "app-1", "role": "reader"}, headers=admin_headers)
    assert resp.status_code == 201
    body = resp.json()
    assert body["key"]
    assert body["signing_secret"]
    assert body["key"] != body["signing_secret"]
    assert body["role"] == "reader"
    assert body["enabled"] is True

    # The plaintext key/secret are never returned again on subsequent reads.
    get_resp = client.get(f"/admin/keys/{body['id']}", headers=admin_headers)
    assert get_resp.status_code == 200
    assert "key" not in get_resp.json()
    assert "signing_secret" not in get_resp.json()


def test_quota_limit_requires_quota_period(client: TestClient, admin_headers: dict[str, str]) -> None:
    _create_role(client, admin_headers)
    resp = client.post(
        "/admin/keys",
        json={"name": "app-1", "role": "reader", "quota_limit": 1000},
        headers=admin_headers,
    )
    assert resp.status_code == 400


def test_list_and_get_key(client: TestClient, admin_headers: dict[str, str]) -> None:
    _create_role(client, admin_headers)
    created = client.post("/admin/keys", json={"name": "app-1", "role": "reader"}, headers=admin_headers).json()

    resp = client.get("/admin/keys", headers=admin_headers)
    assert resp.status_code == 200
    assert len(resp.json()) == 1

    resp = client.get(f"/admin/keys/{created['id']}", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["name"] == "app-1"


def test_get_missing_key_404(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.get("/admin/keys/does-not-exist", headers=admin_headers)
    assert resp.status_code == 404


def test_update_key_can_disable(client: TestClient, admin_headers: dict[str, str]) -> None:
    _create_role(client, admin_headers)
    created = client.post("/admin/keys", json={"name": "app-1", "role": "reader"}, headers=admin_headers).json()

    resp = client.patch(f"/admin/keys/{created['id']}", json={"enabled": False}, headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False

    # Untouched fields are preserved.
    assert resp.json()["role"] == "reader"


def test_update_missing_key_404(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.patch("/admin/keys/does-not-exist", json={"enabled": False}, headers=admin_headers)
    assert resp.status_code == 404


def test_delete_key(client: TestClient, admin_headers: dict[str, str]) -> None:
    _create_role(client, admin_headers)
    created = client.post("/admin/keys", json={"name": "app-1", "role": "reader"}, headers=admin_headers).json()

    resp = client.delete(f"/admin/keys/{created['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert client.get(f"/admin/keys/{created['id']}", headers=admin_headers).status_code == 404
