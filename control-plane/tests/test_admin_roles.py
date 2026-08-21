from fastapi.testclient import TestClient


def test_create_and_get_role(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.post(
        "/admin/roles",
        json={"name": "reader", "permissions": ["orders:read"]},
        headers=admin_headers,
    )
    assert resp.status_code == 201
    assert resp.json() == {"name": "reader", "permissions": ["orders:read"]}

    resp = client.get("/admin/roles/reader", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["permissions"] == ["orders:read"]


def test_create_duplicate_role_conflicts(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.post("/admin/roles", json={"name": "reader", "permissions": []}, headers=admin_headers)
    resp = client.post("/admin/roles", json={"name": "reader", "permissions": []}, headers=admin_headers)
    assert resp.status_code == 409


def test_get_missing_role_404(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.get("/admin/roles/does-not-exist", headers=admin_headers)
    assert resp.status_code == 404


def test_list_roles(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.post("/admin/roles", json={"name": "admin", "permissions": ["*"]}, headers=admin_headers)
    client.post("/admin/roles", json={"name": "reader", "permissions": ["orders:read"]}, headers=admin_headers)

    resp = client.get("/admin/roles", headers=admin_headers)
    assert resp.status_code == 200
    names = [r["name"] for r in resp.json()]
    assert names == ["admin", "reader"]  # alphabetical


def test_delete_role(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.post("/admin/roles", json={"name": "temp", "permissions": []}, headers=admin_headers)
    resp = client.delete("/admin/roles/temp", headers=admin_headers)
    assert resp.status_code == 204
    assert client.get("/admin/roles/temp", headers=admin_headers).status_code == 404


def test_cannot_delete_role_in_use(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.post("/admin/roles", json={"name": "reader", "permissions": []}, headers=admin_headers)
    client.post("/admin/keys", json={"name": "app-1", "role": "reader"}, headers=admin_headers)

    resp = client.delete("/admin/roles/reader", headers=admin_headers)
    assert resp.status_code == 409
