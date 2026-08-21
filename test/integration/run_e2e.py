#!/usr/bin/env python3
"""End-to-end integration proof for Sentinel.

Starts the control plane, the gateway, and two demo upstream services as
real subprocesses, wires up policy through the real Admin API, and
exercises the full request path — routing, authentication, RBAC, OAuth,
rate limiting, request signing, replay protection, and the circuit
breaker's failure-and-recovery behavior — entirely over real HTTP, with
nothing mocked. This is Sentinel's analogue of SyncForge's three-device
convergence test: a genuine, assertion-based proof, not just a demo.

Usage:
    python test/integration/run_e2e.py

Requires:
    - control-plane/.venv set up: pip install -r requirements-dev.txt
      plus `requests` (see control-plane/requirements-dev.txt)
    - gateway already built: npm --prefix gateway run build
Exits 0 if every check passed, 1 otherwise.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_mod
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
CONTROL_PLANE_DIR = ROOT / "control-plane"
GATEWAY_DIR = ROOT / "gateway"
SERVICES_DIR = ROOT / "services"

CONTROL_PLANE_PORT = 8300
GATEWAY_PORT = 8301
ORDERS_PORT = 8302
FLAKY_PORT = 8303

CONTROL_PLANE_URL = f"http://127.0.0.1:{CONTROL_PLANE_PORT}"
GATEWAY_URL = f"http://127.0.0.1:{GATEWAY_PORT}"
ORDERS_URL = f"http://127.0.0.1:{ORDERS_PORT}"
FLAKY_URL = f"http://127.0.0.1:{FLAKY_PORT}"

ADMIN_TOKEN = "dev-admin-token"
INTERNAL_TOKEN = "dev-internal-token"

# Short circuit-breaker/health-check timing so the failure->recovery
# scenario runs in seconds, not the 30s production default.
BREAKER_FAILURE_THRESHOLD = "3"
BREAKER_RESET_MS = "1500"
HEALTH_CHECK_INTERVAL_MS = "1000"

results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, condition, detail))
    marker = "OK" if condition else "XX"
    print(f"  [{marker}] {name}" + (f" -- {detail}" if detail and not condition else ""))


def venv_python() -> str:
    """Prefer control-plane's own venv (matches local dev setup); fall
    back to whichever interpreter is running this script (CI installs
    dependencies directly, no venv)."""
    windows = CONTROL_PLANE_DIR / ".venv" / "Scripts" / "python.exe"
    if windows.exists():
        return str(windows)
    posix = CONTROL_PLANE_DIR / ".venv" / "bin" / "python"
    if posix.exists():
        return str(posix)
    return sys.executable


def wait_for(url: str, timeout: float = 15.0) -> None:
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            resp = requests.get(url, timeout=1)
            if resp.status_code < 500:
                return
        except requests.RequestException as exc:
            last_err = exc
        time.sleep(0.2)
    raise TimeoutError(f"{url} did not become ready in {timeout}s: {last_err}")


def remove_db_file(db_path: Path) -> None:
    """Best-effort delete: on Windows, a just-terminated uvicorn process
    can briefly hold the sqlite file open even after proc.wait() returns,
    so a bare unlink() can raise PermissionError. Retry a few times rather
    than letting that abort the whole script and swallow the results
    summary."""
    for attempt in range(10):
        try:
            db_path.unlink(missing_ok=True)
            return
        except PermissionError:
            if attempt == 9:
                print(f"  (warning: could not remove {db_path}, leaving it in place)")
                return
            time.sleep(0.3)


def main() -> int:
    print("Sentinel end-to-end integration proof\n")

    db_path = Path(__file__).resolve().parent / ".e2e-control-plane.db"
    remove_db_file(db_path)

    procs: list[subprocess.Popen] = []

    def spawn(cmd: list[str], cwd: Path, env: dict[str, str]) -> subprocess.Popen:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), env={**os.environ, **env},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        procs.append(proc)
        return proc

    try:
        print("Starting control plane and demo services...")
        spawn(
            [str(venv_python()), "-m", "uvicorn", "app.main:app", "--port", str(CONTROL_PLANE_PORT)],
            CONTROL_PLANE_DIR,
            {
                "SENTINEL_DB_PATH": str(db_path),
                "SENTINEL_ADMIN_TOKEN": ADMIN_TOKEN,
                "SENTINEL_INTERNAL_TOKEN": INTERNAL_TOKEN,
            },
        )
        spawn([str(venv_python()), "orders_service.py", str(ORDERS_PORT)], SERVICES_DIR, {})
        spawn([str(venv_python()), "flaky_service.py", str(FLAKY_PORT)], SERVICES_DIR, {})

        wait_for(f"{CONTROL_PLANE_URL}/healthz")
        wait_for(f"{ORDERS_URL}/healthz")
        wait_for(f"{FLAKY_URL}/healthz")
        print("  control plane, orders service, and flaky service are up.\n")

        print("Configuring policy via the Admin API...")
        admin_headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
        requests.post(f"{CONTROL_PLANE_URL}/admin/roles",
                      json={"name": "reader", "permissions": ["orders:read"]}, headers=admin_headers)
        requests.post(f"{CONTROL_PLANE_URL}/admin/roles",
                      json={"name": "writer", "permissions": ["orders:read", "orders:write"]}, headers=admin_headers)

        # reader_key has no rate-limit override (generous defaults), so
        # scenarios 1, 2, and 5 aren't affected by scenario 3's own
        # rate-limit exhaustion — that gets a dedicated, low-limit key.
        reader_key = requests.post(
            f"{CONTROL_PLANE_URL}/admin/keys", json={"name": "reader-app", "role": "reader"}, headers=admin_headers,
        ).json()
        signed_key = requests.post(
            f"{CONTROL_PLANE_URL}/admin/keys", json={"name": "signed-app", "role": "writer"}, headers=admin_headers,
        ).json()
        limited_key = requests.post(
            f"{CONTROL_PLANE_URL}/admin/keys",
            json={"name": "rate-limited-app", "role": "reader", "rate_limit_per_second": 2, "rate_limit_burst": 3},
            headers=admin_headers,
        ).json()

        requests.post(
            f"{CONTROL_PLANE_URL}/admin/routes",
            json={"path_prefix": "/orders", "upstreams": [ORDERS_URL], "strip_prefix": False,
                  "auth_required": True, "required_permission": "orders:read"},
            headers=admin_headers,
        )
        requests.post(
            f"{CONTROL_PLANE_URL}/admin/routes",
            json={"path_prefix": "/widgets", "upstreams": [FLAKY_URL], "strip_prefix": False,
                  "auth_required": True, "required_permission": None},
            headers=admin_headers,
        )
        requests.post(
            f"{CONTROL_PLANE_URL}/admin/routes",
            json={"path_prefix": "/signed", "upstreams": [ORDERS_URL], "strip_prefix": True,
                  "auth_required": True, "required_permission": "orders:write", "require_signature": True},
            headers=admin_headers,
        )
        print("  roles, keys, and routes created.\n")

        print("Starting the gateway...")
        spawn(
            ["node", "dist/src/index.js"],
            GATEWAY_DIR,
            {
                "PORT": str(GATEWAY_PORT),
                "SENTINEL_CONTROL_PLANE_URL": CONTROL_PLANE_URL,
                "SENTINEL_INTERNAL_TOKEN": INTERNAL_TOKEN,
                "SENTINEL_CONFIG_POLL_MS": "1000",
                "SENTINEL_BREAKER_FAILURE_THRESHOLD": BREAKER_FAILURE_THRESHOLD,
                "SENTINEL_BREAKER_RESET_MS": BREAKER_RESET_MS,
                "SENTINEL_HEALTH_CHECK_INTERVAL_MS": HEALTH_CHECK_INTERVAL_MS,
            },
        )
        wait_for(f"{GATEWAY_URL}/healthz")
        time.sleep(1.5)  # let the gateway's first config poll land
        print("  gateway is up and has polled its initial config.\n")

        print("Scenario 1: routing, authentication, and RBAC")
        r = requests.get(f"{GATEWAY_URL}/orders")
        check("unauthenticated request to a protected route is rejected", r.status_code == 401)

        r = requests.get(f"{GATEWAY_URL}/orders", headers={"X-Api-Key": reader_key["key"]})
        check("valid API key reaches the real upstream", r.status_code == 200 and "orders" in r.json())

        r = requests.get(f"{GATEWAY_URL}/orders/1", headers={"X-Api-Key": reader_key["key"]})
        check("sub-path routes through to the right upstream resource",
              r.status_code == 200 and r.json().get("id") == "1")

        r = requests.get(f"{GATEWAY_URL}/signed", headers={"X-Api-Key": reader_key["key"]})
        check("caller without the required permission is forbidden by RBAC", r.status_code == 403)
        print()

        print("Scenario 2: OAuth client_credentials")
        token_resp = requests.post(
            f"{CONTROL_PLANE_URL}/oauth/token",
            data={"grant_type": "client_credentials", "client_id": reader_key["id"], "client_secret": reader_key["key"]},
        ).json()
        check("OAuth token endpoint issues a bearer token", "access_token" in token_resp)

        r = requests.get(f"{GATEWAY_URL}/orders", headers={"Authorization": f"Bearer {token_resp.get('access_token')}"})
        check("gateway accepts the OAuth-issued JWT for the same identity", r.status_code == 200)
        print()

        print("Scenario 3: rate limiting")
        statuses = [requests.get(f"{GATEWAY_URL}/orders", headers={"X-Api-Key": limited_key["key"]}).status_code
                    for _ in range(6)]
        check("a burst beyond the configured limit is eventually rate limited", 429 in statuses, f"statuses={statuses}")
        print()

        print("Scenario 4: request signing and replay protection")
        timestamp = str(int(time.time() * 1000))
        nonce = str(uuid.uuid4())
        body = json.dumps({"item": "Sprocket", "quantity": 2})
        signing_input = f"{timestamp}.{nonce}.".encode() + body.encode()
        signature = hmac_mod.new(signed_key["signing_secret"].encode(), signing_input, hashlib.sha256).hexdigest()
        sign_headers = {
            "X-Api-Key": signed_key["key"], "X-Signature": signature,
            "X-Signature-Timestamp": timestamp, "X-Nonce": nonce, "Content-Type": "application/json",
        }
        r = requests.post(f"{GATEWAY_URL}/signed/orders", data=body, headers=sign_headers)
        check("correctly signed request is accepted", r.status_code == 201, f"status={r.status_code} body={r.text}")

        r2 = requests.post(f"{GATEWAY_URL}/signed/orders", data=body, headers=sign_headers)
        check("replaying the same nonce is rejected", r2.status_code == 401)
        print()

        print("Scenario 5: upstream failure trips the circuit breaker, health checks recover it")
        requests.post(f"{FLAKY_URL}/admin/mode", json={"mode": "failing"})

        tripped = False
        for _ in range(10):
            resp = requests.get(f"{GATEWAY_URL}/widgets", headers={"X-Api-Key": reader_key["key"]})
            if resp.status_code == 503:
                tripped = True
                break
        check("repeated upstream failures trip the breaker (503, short-circuited)", tripped)

        requests.post(f"{FLAKY_URL}/admin/mode", json={"mode": "healthy"})
        recovered = False
        deadline = time.time() + 15
        while time.time() < deadline:
            resp = requests.get(f"{GATEWAY_URL}/widgets", headers={"X-Api-Key": reader_key["key"]})
            if resp.status_code == 200:
                recovered = True
                break
            time.sleep(0.5)
        check("gateway resumes proxying once the upstream recovers", recovered)
        print()

    finally:
        for proc in procs:
            proc.terminate()
        for proc in procs:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        remove_db_file(db_path)

    print("=" * 70)
    for name, passed, detail in results:
        print(f"  {'PASS' if passed else 'FAIL'}: {name}" + (f" ({detail})" if detail else ""))
    print("=" * 70)

    failed = [r for r in results if not r[1]]
    if failed:
        print(f"\n{len(failed)} of {len(results)} checks FAILED.")
        return 1
    print(f"\nAll {len(results)} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
