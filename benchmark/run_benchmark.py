#!/usr/bin/env python3
"""Sentinel benchmark.

Starts the control plane, gateway, and two demo upstream services as real
subprocesses, wires up policy through the real Admin API, then runs three
load-test scenarios against the real running gateway:

  A. steady-state throughput and latency
  B. rate-limit shedding under concurrent load
  C. backend failure -> circuit breaker -> recovery, with a measured
     recovery time

Prints a report. See docs/BENCHMARK.md for a captured run's numbers and
analysis.

Usage:
    python benchmark/run_benchmark.py

Requires: control-plane/.venv with control-plane/requirements-dev.txt AND
benchmark/requirements.txt installed, and the gateway already built
(npm --prefix gateway run build).
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_test import run_load_test  # noqa: E402

import requests

ROOT = Path(__file__).resolve().parents[1]
CONTROL_PLANE_DIR = ROOT / "control-plane"
GATEWAY_DIR = ROOT / "gateway"
SERVICES_DIR = ROOT / "services"

CONTROL_PLANE_PORT = 8400
GATEWAY_PORT = 8401
ORDERS_PORT = 8402
FLAKY_PORT = 8403

CONTROL_PLANE_URL = f"http://127.0.0.1:{CONTROL_PLANE_PORT}"
GATEWAY_URL = f"http://127.0.0.1:{GATEWAY_PORT}"
ORDERS_URL = f"http://127.0.0.1:{ORDERS_PORT}"
FLAKY_URL = f"http://127.0.0.1:{FLAKY_PORT}"

ADMIN_TOKEN = "dev-admin-token"
INTERNAL_TOKEN = "dev-internal-token"

CONCURRENCY = 20


def venv_python() -> Path:
    windows = CONTROL_PLANE_DIR / ".venv" / "Scripts" / "python.exe"
    return windows if windows.exists() else CONTROL_PLANE_DIR / ".venv" / "bin" / "python"


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
    for attempt in range(10):
        try:
            db_path.unlink(missing_ok=True)
            return
        except PermissionError:
            if attempt == 9:
                print(f"  (warning: could not remove {db_path}, leaving it in place)")
                return
            time.sleep(0.3)


def indent(text: str, prefix: str = "    ") -> str:
    return "\n".join(prefix + line for line in text.splitlines())


async def main() -> int:
    print("Sentinel benchmark\n")
    db_path = Path(__file__).resolve().parent / ".benchmark-control-plane.db"
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

        admin_headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
        requests.post(f"{CONTROL_PLANE_URL}/admin/roles", json={"name": "bench", "permissions": ["*"]}, headers=admin_headers)
        bench_key = requests.post(
            f"{CONTROL_PLANE_URL}/admin/keys",
            json={"name": "bench-app", "role": "bench", "rate_limit_per_second": 1000, "rate_limit_burst": 1000},
            headers=admin_headers,
        ).json()
        limited_key = requests.post(
            f"{CONTROL_PLANE_URL}/admin/keys",
            json={"name": "limited-bench-app", "role": "bench", "rate_limit_per_second": 20, "rate_limit_burst": 20},
            headers=admin_headers,
        ).json()
        requests.post(
            f"{CONTROL_PLANE_URL}/admin/routes",
            json={"path_prefix": "/orders", "upstreams": [ORDERS_URL], "strip_prefix": False, "auth_required": True},
            headers=admin_headers,
        )
        requests.post(
            f"{CONTROL_PLANE_URL}/admin/routes",
            json={"path_prefix": "/widgets", "upstreams": [FLAKY_URL], "strip_prefix": False, "auth_required": True},
            headers=admin_headers,
        )

        spawn(
            ["node", "dist/src/index.js"],
            GATEWAY_DIR,
            {
                "PORT": str(GATEWAY_PORT),
                "SENTINEL_CONTROL_PLANE_URL": CONTROL_PLANE_URL,
                "SENTINEL_INTERNAL_TOKEN": INTERNAL_TOKEN,
                "SENTINEL_CONFIG_POLL_MS": "1000",
                "SENTINEL_BREAKER_FAILURE_THRESHOLD": "5",
                "SENTINEL_BREAKER_RESET_MS": "3000",
                "SENTINEL_HEALTH_CHECK_INTERVAL_MS": "1000",
            },
        )
        wait_for(f"{GATEWAY_URL}/healthz")
        time.sleep(1.5)
        print("  all processes up.\n")

        print(f"Scenario A: steady-state throughput and latency ({CONCURRENCY} concurrent clients, 15s)")
        result_a = await run_load_test(
            f"{GATEWAY_URL}/orders", concurrency=CONCURRENCY, duration_s=15,
            headers={"X-Api-Key": bench_key["key"]},
        )
        print(indent(result_a.summary()))
        print()

        print(f"Scenario B: rate-limit shedding under load ({CONCURRENCY} concurrent clients, 10s, limit=20/s burst=20)")
        result_b = await run_load_test(
            f"{GATEWAY_URL}/orders", concurrency=CONCURRENCY, duration_s=10,
            headers={"X-Api-Key": limited_key["key"]},
        )
        print(indent(result_b.summary()))
        print()

        print(f"Scenario C: backend failure -> circuit breaker -> recovery ({CONCURRENCY} concurrent clients)")
        print("  phase 1: healthy backend, 5s baseline")
        phase1 = await run_load_test(
            f"{GATEWAY_URL}/widgets", concurrency=CONCURRENCY, duration_s=5, headers={"X-Api-Key": bench_key["key"]}
        )
        print(indent(phase1.summary(), "    "))

        print("  phase 2: backend set to failing, 8s under load")
        requests.post(f"{FLAKY_URL}/admin/mode", json={"mode": "failing"})
        phase2 = await run_load_test(
            f"{GATEWAY_URL}/widgets", concurrency=CONCURRENCY, duration_s=8, headers={"X-Api-Key": bench_key["key"]}
        )
        print(indent(phase2.summary(), "    "))
        print("    -> the breaker converts sustained backend failure into fast local 503 rejections instead of")
        print("       every caller waiting out a slow, failing upstream call: see the p99/max latency drop below.")

        print("  phase 3: backend restored, timing recovery")
        requests.post(f"{FLAKY_URL}/admin/mode", json={"mode": "healthy"})
        recovered_after: float | None = None
        deadline = time.time() + 15
        probe_start = time.time()
        while time.time() < deadline:
            r = requests.get(f"{GATEWAY_URL}/widgets", headers={"X-Api-Key": bench_key["key"]})
            if r.status_code == 200:
                recovered_after = time.time() - probe_start
                break
            time.sleep(0.2)
        if recovered_after is not None:
            print(f"    recovered after {recovered_after:.2f}s")
        else:
            print("    DID NOT RECOVER within 15s")
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

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
