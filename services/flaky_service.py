"""Deliberately controllable demo upstream: toggle its behavior via
POST /admin/mode {"mode": "healthy"|"failing"|"slow"}, used to exercise
Sentinel's health checks and circuit breaker under real, repeatable
failure conditions (rather than a randomly-flaky service, which would make
the integration proof and benchmark non-deterministic).
"""

from __future__ import annotations

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state = {"mode": "healthy"}  # healthy | failing | slow
SLOW_DELAY_SECONDS = 2.0


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, body: object) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            if state["mode"] == "failing":
                self._send_json(503, {"status": "unhealthy"})
            else:
                self._send_json(200, {"status": "ok"})
            return
        if self.path == "/widgets":
            if state["mode"] == "failing":
                self._send_json(500, {"error": "internal error"})
                return
            if state["mode"] == "slow":
                time.sleep(SLOW_DELAY_SECONDS)
            self._send_json(200, {"widgets": ["a", "b", "c"]})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/admin/mode":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
            mode = body.get("mode")
            if mode not in ("healthy", "failing", "slow"):
                self._send_json(400, {"error": "mode must be healthy, failing, or slow"})
                return
            state["mode"] = mode
            self._send_json(200, {"mode": mode})
            return
        self._send_json(404, {"error": "not found"})

    def log_message(self, format: str, *args: object) -> None:
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 256
    allow_reuse_address = True


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9002
    server = Server(("127.0.0.1", port), Handler)
    print(f"flaky_service: listening on :{port} (mode={state['mode']})")
    server.serve_forever()


if __name__ == "__main__":
    main()
