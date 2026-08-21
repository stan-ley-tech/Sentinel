"""Minimal demo upstream service: a stand-in for a real backend API that
Sentinel proxies to. Pure stdlib (no dependencies) so it starts instantly
and needs nothing installed beyond Python itself. Used by the end-to-end
integration proof and by the benchmark suite as the reverse proxy's
target.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ORDERS: dict[str, dict] = {
    "1": {"id": "1", "item": "Widget", "quantity": 4},
    "2": {"id": "2", "item": "Gadget", "quantity": 1},
}


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
            self._send_json(200, {"status": "ok"})
            return
        if self.path == "/orders":
            self._send_json(200, {"orders": list(ORDERS.values())})
            return
        if self.path.startswith("/orders/"):
            order_id = self.path.removeprefix("/orders/")
            order = ORDERS.get(order_id)
            self._send_json(200, order) if order is not None else self._send_json(404, {"error": "order not found"})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/orders":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
            order_id = str(len(ORDERS) + 1)
            order = {"id": order_id, **body}
            ORDERS[order_id] = order
            self._send_json(201, order)
            return
        self._send_json(404, {"error": "not found"})

    def log_message(self, format: str, *args: object) -> None:  # keep stdout quiet under load
        pass


class Server(ThreadingHTTPServer):
    # The socketserver default (5) is too small to be a fair upstream for
    # benchmarking a gateway under real concurrency — it would measure this
    # toy server's queue depth, not Sentinel's overhead.
    request_queue_size = 256
    allow_reuse_address = True


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9001
    server = Server(("127.0.0.1", port), Handler)
    print(f"orders_service: listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
