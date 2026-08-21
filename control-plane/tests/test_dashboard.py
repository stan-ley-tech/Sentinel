from fastapi.testclient import TestClient

from app.auth import ADMIN_TOKEN


def test_dashboard_requires_auth(client: TestClient) -> None:
    resp = client.get("/dashboard")
    assert resp.status_code == 401


def test_dashboard_rejects_wrong_password(client: TestClient) -> None:
    resp = client.get("/dashboard", auth=("admin", "wrong-password"))
    assert resp.status_code == 401


def test_dashboard_accepts_admin_token_as_basic_auth_password(client: TestClient) -> None:
    resp = client.get("/dashboard", auth=("anything", ADMIN_TOKEN))
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]


def test_dashboard_renders_empty_state_with_no_data(client: TestClient) -> None:
    resp = client.get("/dashboard", auth=("admin", ADMIN_TOKEN))
    assert resp.status_code == 200
    assert "No API keys yet" in resp.text
    assert "No routes configured" in resp.text
    assert "No metrics received from the gateway yet" in resp.text
    assert "No requests recorded yet" in resp.text


def test_dashboard_renders_keys_and_routes(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.post("/admin/roles", json={"name": "reader", "permissions": ["orders:read"]}, headers=admin_headers)
    client.post("/admin/keys", json={"name": "Mobile App", "role": "reader"}, headers=admin_headers)
    client.post(
        "/admin/routes",
        json={"path_prefix": "/v1/orders", "upstreams": ["http://127.0.0.1:9001"]},
        headers=admin_headers,
    )

    resp = client.get("/dashboard", auth=("admin", ADMIN_TOKEN))
    assert resp.status_code == 200
    assert "Mobile App" in resp.text
    assert "/v1/orders" in resp.text


def test_dashboard_renders_audit_entries_and_metrics(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    client.post(
        "/internal/audit",
        json={
            "entries": [
                {
                    "timestamp": "2026-01-15T12:00:00Z", "method": "GET", "path": "/v1/orders",
                    "clientIp": "203.0.113.5", "apiKeyId": "key-1", "role": "reader", "routeId": "r1",
                    "allowed": True, "stage": None, "statusCode": 200, "durationMs": 8.2,
                }
            ]
        },
        headers=internal_headers,
    )
    client.post(
        "/internal/metrics",
        json={
            "requests": [{"route": "r1", "status": 200, "count": 1}],
            "avgLatencyMs": [{"route": "r1", "avgMs": 8.2}],
            "rejections": [{"stage": "auth", "count": 2}],
            "upstreams": [{"upstream": "http://127.0.0.1:9001", "healthy": True, "circuitState": "closed"}],
        },
        headers=internal_headers,
    )

    resp = client.get("/dashboard", auth=("admin", ADMIN_TOKEN))
    assert resp.status_code == 200
    assert "203.0.113.5" in resp.text
    assert "http://127.0.0.1:9001" in resp.text
    assert "healthy" in resp.text
    assert "auth" in resp.text
