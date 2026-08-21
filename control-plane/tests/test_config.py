from fastapi.testclient import TestClient


def test_config_requires_internal_token(client: TestClient) -> None:
    resp = client.get("/internal/config")
    assert resp.status_code == 401


def test_config_rejects_admin_token(client: TestClient, admin_headers: dict[str, str]) -> None:
    # The admin token and internal token are different trust boundaries —
    # one must not work for the other.
    resp = client.get("/internal/config", headers=admin_headers)
    assert resp.status_code == 401


def test_config_snapshot_reflects_admin_state(
    client: TestClient, admin_headers: dict[str, str], internal_headers: dict[str, str]
) -> None:
    client.post("/admin/roles", json={"name": "reader", "permissions": ["orders:read"]}, headers=admin_headers)
    key = client.post("/admin/keys", json={"name": "app-1", "role": "reader"}, headers=admin_headers).json()
    client.post(
        "/admin/routes",
        json={"path_prefix": "/v1/orders", "upstreams": ["http://127.0.0.1:9001"]},
        headers=admin_headers,
    )
    client.post("/admin/ip-rules", json={"cidr": "10.0.0.0/8", "action": "deny"}, headers=admin_headers)

    resp = client.get("/internal/config", headers=internal_headers)
    assert resp.status_code == 200
    body = resp.json()

    assert body["roles"] == {"reader": ["orders:read"]}
    assert len(body["api_keys"]) == 1
    assert body["api_keys"][0]["id"] == key["id"]
    assert body["api_keys"][0]["signing_secret"]  # gateway needs the plaintext to verify HMAC signatures
    assert "key" not in body["api_keys"][0]  # but never the plaintext API key itself
    assert body["api_keys"][0]["key_hash"]  # only the hash, for X-API-Key verification

    assert len(body["routes"]) == 1
    assert body["routes"][0]["path_prefix"] == "/v1/orders"

    assert len(body["ip_rules"]) == 1
    assert body["ip_rules"][0]["cidr"] == "10.0.0.0/8"

    assert body["jwt_secret"]


def test_jwt_secret_is_stable_across_calls(client: TestClient, internal_headers: dict[str, str]) -> None:
    first = client.get("/internal/config", headers=internal_headers).json()["jwt_secret"]
    second = client.get("/internal/config", headers=internal_headers).json()["jwt_secret"]
    assert first == second
