from fastapi.testclient import TestClient


def test_create_ip_rule(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.post(
        "/admin/ip-rules",
        json={"cidr": "10.0.0.0/8", "action": "deny", "priority": 5},
        headers=admin_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["cidr"] == "10.0.0.0/8"
    assert body["action"] == "deny"
    assert body["id"]


def test_create_ip_rule_rejects_invalid_action(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.post(
        "/admin/ip-rules", json={"cidr": "10.0.0.0/8", "action": "block"}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_create_ip_rule_rejects_invalid_cidr(client: TestClient, admin_headers: dict[str, str]) -> None:
    resp = client.post(
        "/admin/ip-rules", json={"cidr": "not-an-ip", "action": "allow"}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_list_ip_rules_ordered_by_priority(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.post("/admin/ip-rules", json={"cidr": "10.0.0.0/8", "action": "deny", "priority": 1}, headers=admin_headers)
    client.post("/admin/ip-rules", json={"cidr": "192.168.0.0/16", "action": "allow", "priority": 10}, headers=admin_headers)

    resp = client.get("/admin/ip-rules", headers=admin_headers)
    assert resp.status_code == 200
    cidrs = [r["cidr"] for r in resp.json()]
    assert cidrs == ["192.168.0.0/16", "10.0.0.0/8"]  # higher priority first


def test_delete_ip_rule(client: TestClient, admin_headers: dict[str, str]) -> None:
    created = client.post(
        "/admin/ip-rules", json={"cidr": "10.0.0.0/8", "action": "deny"}, headers=admin_headers
    ).json()
    resp = client.delete(f"/admin/ip-rules/{created['id']}", headers=admin_headers)
    assert resp.status_code == 204
    remaining = client.get("/admin/ip-rules", headers=admin_headers).json()
    assert remaining == []
