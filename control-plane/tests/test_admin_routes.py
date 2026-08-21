from fastapi.testclient import TestClient

VALID_ROUTE = {
    "path_prefix": "/v1/orders",
    "upstreams": ["http://127.0.0.1:9001"],
    "strip_prefix": True,
    "auth_required": True,
    "required_permission": "orders:read",
}


def test_create_route(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.post("/admin/routes", json=VALID_ROUTE, headers=admin_headers)
    assert resp.status_code == 201
    body = resp.json()
    assert body["path_prefix"] == "/v1/orders"
    assert body["upstreams"] == ["http://127.0.0.1:9001"]
    assert body["id"]


def test_create_route_rejects_bad_path_prefix(client: TestClient, admin_headers: dict[str, str]) -> None:
    bad = {**VALID_ROUTE, "path_prefix": "v1/orders"}
    resp = client.post("/admin/routes", json=bad, headers=admin_headers)
    assert resp.status_code == 400


def test_create_route_rejects_empty_upstreams(client: TestClient, admin_headers: dict[str, str]) -> None:
    bad = {**VALID_ROUTE, "upstreams": []}
    resp = client.post("/admin/routes", json=bad, headers=admin_headers)
    assert resp.status_code == 400


def test_create_route_rejects_invalid_upstream_url(client: TestClient, admin_headers: dict[str, str]) -> None:
    bad = {**VALID_ROUTE, "upstreams": ["not-a-url"]}
    resp = client.post("/admin/routes", json=bad, headers=admin_headers)
    assert resp.status_code == 400


def test_list_and_get_route(client: TestClient, admin_headers: dict[str, str]) -> None:
    created = client.post("/admin/routes", json=VALID_ROUTE, headers=admin_headers).json()

    resp = client.get("/admin/routes", headers=admin_headers)
    assert resp.status_code == 200
    assert len(resp.json()) == 1

    resp = client.get(f"/admin/routes/{created['id']}", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["path_prefix"] == "/v1/orders"


def test_update_route(client: TestClient, admin_headers: dict[str, str]) -> None:
    created = client.post("/admin/routes", json=VALID_ROUTE, headers=admin_headers).json()
    updated = {**VALID_ROUTE, "upstreams": ["http://127.0.0.1:9002"]}

    resp = client.put(f"/admin/routes/{created['id']}", json=updated, headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["upstreams"] == ["http://127.0.0.1:9002"]
    assert resp.json()["created_at"] == created["created_at"]


def test_update_missing_route_404(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.put("/admin/routes/does-not-exist", json=VALID_ROUTE, headers=admin_headers)
    assert resp.status_code == 404


def test_delete_route(client: TestClient, admin_headers: dict[str, str]) -> None:
    created = client.post("/admin/routes", json=VALID_ROUTE, headers=admin_headers).json()
    resp = client.delete(f"/admin/routes/{created['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert client.get(f"/admin/routes/{created['id']}", headers=admin_headers).status_code == 404
