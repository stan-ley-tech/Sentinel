"""Async load generator built on aiohttp — the tool behind
docs/BENCHMARK.md's throughput/latency/failure numbers. Real concurrent
HTTP/1.1 connections against the real running gateway, not a toy.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

import aiohttp


@dataclass
class RequestResult:
    status: int  # 0 for a connection-level error (timeout, refused, etc.)
    latency_ms: float
    error: str | None = None


@dataclass
class LoadTestResult:
    results: list[RequestResult] = field(default_factory=list)
    duration_s: float = 0.0

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def throughput_rps(self) -> float:
        return self.total / self.duration_s if self.duration_s > 0 else 0.0

    def status_counts(self) -> dict[int, int]:
        counts: dict[int, int] = {}
        for r in self.results:
            counts[r.status] = counts.get(r.status, 0) + 1
        return counts

    def latencies_ms(self, statuses: frozenset[int] | None = None) -> list[float]:
        return [r.latency_ms for r in self.results if statuses is None or r.status in statuses]

    def percentile(self, p: float, statuses: frozenset[int] | None = None) -> float:
        lat = sorted(self.latencies_ms(statuses))
        if not lat:
            return 0.0
        k = max(0, min(len(lat) - 1, int(round(p / 100 * (len(lat) - 1)))))
        return lat[k]

    def summary(self, ok_statuses: frozenset[int] = frozenset({200, 201})) -> str:
        counts = self.status_counts()
        ok_lat = self.latencies_ms(ok_statuses)
        lines = [
            f"requests={self.total} duration={self.duration_s:.2f}s throughput={self.throughput_rps:.1f} req/s",
            f"status counts: {dict(sorted(counts.items()))}",
        ]
        if ok_lat:
            lines.append(
                "latency (successful) ms: "
                f"p50={self.percentile(50, ok_statuses):.1f} "
                f"p95={self.percentile(95, ok_statuses):.1f} "
                f"p99={self.percentile(99, ok_statuses):.1f} "
                f"max={max(ok_lat):.1f}"
            )
        return "\n".join(lines)


async def _worker(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    headers: dict[str, str],
    stop_at: float,
    results: list[RequestResult],
    body: str | None,
) -> None:
    while time.monotonic() < stop_at:
        started = time.monotonic()
        try:
            async with session.request(method, url, headers=headers, data=body) as resp:
                await resp.read()
                results.append(RequestResult(status=resp.status, latency_ms=(time.monotonic() - started) * 1000))
        except Exception as exc:  # connection errors, timeouts, etc. — recorded, not raised
            results.append(RequestResult(status=0, latency_ms=(time.monotonic() - started) * 1000, error=str(exc)))


async def run_load_test(
    url: str,
    *,
    concurrency: int,
    duration_s: float,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: str | None = None,
) -> LoadTestResult:
    """Runs `concurrency` worker coroutines in a tight request loop against
    url for duration_s seconds, each recording its own status and latency.
    """
    results: list[RequestResult] = []
    connector = aiohttp.TCPConnector(limit=concurrency + 10)
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        stop_at = time.monotonic() + duration_s
        start = time.monotonic()
        workers = [
            asyncio.create_task(_worker(session, method, url, headers or {}, stop_at, results, body))
            for _ in range(concurrency)
        ]
        await asyncio.gather(*workers)
        elapsed = time.monotonic() - start

    return LoadTestResult(results=results, duration_s=elapsed)
