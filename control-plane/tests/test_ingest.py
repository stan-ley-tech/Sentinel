import json

import pytest
from fastapi.testclient import TestClient


def sample_audit_entry(**overrides: object) -> dict:
    entry = {
        "timestamp": "2026-01-15T12:00:00Z",
        "method": "GET",
        "path": "/v1/orders",
        "clientIp": "203.0.113.5",
        "apiKeyId": "key-1",
        "role": "reader",
        "routeId": "r1",
        "allowed": True,
        "stage": None,
        "statusCode": 200,
        "durationMs": 12.5,
    }
    entry.update(overrides)
    return entry


def test_ingest_audit_requires_internal_token(client: TestClient) -> None:
    resp = client.post("/internal/audit", json={"entries": [sample_audit_entry()]})
    assert resp.status_code == 401


def test_ingest_audit_rejects_admin_token(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.post("/internal/audit", json={"entries": []}, headers=admin_headers)
    assert resp.status_code == 401


def test_ingest_audit_stores_entries(client: TestClient, internal_headers: dict[str, str], db_conn) -> None:
    resp = client.post(
        "/internal/audit",
        json={"entries": [sample_audit_entry(), sample_audit_entry(allowed=False, stage="auth", statusCode=401)]},
        headers=internal_headers,
    )
    assert resp.status_code == 200
    assert resp.json() == {"accepted": 2}

    rows = db_conn.execute("SELECT * FROM audit_log ORDER BY id").fetchall()
    assert len(rows) == 2
    assert rows[0]["path"] == "/v1/orders"
    assert rows[0]["api_key_id"] == "key-1"
    assert bool(rows[1]["allowed"]) is False
    assert rows[1]["stage"] == "auth"


def test_ingest_audit_trims_to_max_rows(
    client: TestClient, internal_headers: dict[str, str], db_conn, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.routers.ingest.MAX_AUDIT_LOG_ROWS", 3)

    for i in range(5):
        client.post(
            "/internal/audit",
            json={"entries": [sample_audit_entry(path=f"/v1/orders/{i}")]},
            headers=internal_headers,
        )

    rows = db_conn.execute("SELECT path FROM audit_log ORDER BY id").fetchall()
    assert len(rows) == 3
    # The oldest entries were trimmed; the most recent 3 remain.
    assert [r["path"] for r in rows] == ["/v1/orders/2", "/v1/orders/3", "/v1/orders/4"]


def test_ingest_metrics_requires_internal_token(client: TestClient) -> None:
    resp = client.post("/internal/metrics", json={"requests": []})
    assert resp.status_code == 401


def test_ingest_metrics_stores_and_overwrites_latest_snapshot(
    client: TestClient, internal_headers: dict[str, str], db_conn
) -> None:
    first = {"requests": [{"route": "r1", "status": 200, "count": 1}], "avgLatencyMs": [], "rejections": [], "upstreams": []}
    resp = client.post("/internal/metrics", json=first, headers=internal_headers)
    assert resp.status_code == 200

    row = db_conn.execute("SELECT value FROM settings WHERE key = 'latest_metrics'").fetchone()
    assert json.loads(row["value"]) == first

    second = {"requests": [{"route": "r1", "status": 200, "count": 2}], "avgLatencyMs": [], "rejections": [], "upstreams": []}
    client.post("/internal/metrics", json=second, headers=internal_headers)
    row = db_conn.execute("SELECT value FROM settings WHERE key = 'latest_metrics'").fetchone()
    assert json.loads(row["value"]) == second
