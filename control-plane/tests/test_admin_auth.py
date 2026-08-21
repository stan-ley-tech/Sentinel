from fastapi.testclient import TestClient


def test_admin_endpoint_requires_bearer_token(client: TestClient) -> None:
    resp = client.get("/admin/roles")
    assert resp.status_code == 401


def test_admin_endpoint_rejects_wrong_token(client: TestClient) -> None:
    resp = client.get("/admin/roles", headers={"Authorization": "Bearer not-the-token"})
    assert resp.status_code == 401


def test_admin_endpoint_accepts_correct_token(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.get("/admin/roles", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json() == []
