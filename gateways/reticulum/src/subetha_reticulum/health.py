"""A minimal HTTP server for container platforms: GET /health, and POST /deliver for
relay-pushed LXMF deliveries (endpoints of kind "lxmf"), HMAC-signed like webhooks:
X-SubEtha-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>."""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable


MAX_BODY = 64 * 1024
TOLERANCE_S = 300


def verify_signature(secret: str, body: bytes, header: str | None, now: float | None = None) -> bool:
    if not header or not secret:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs((now if now is not None else time.time()) - t) > TOLERANCE_S:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in (p.split("=", 1) for p in header.split(",") if "=" in p) if k == "v1")


def serve_health(
    port: int,
    status: Callable[[], dict[str, Any]],
    host: str = "0.0.0.0",
    deliver: Callable[[str, dict[str, Any]], None] | None = None,
    deliver_secret: str | None = None,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/deliver" or deliver is None or not deliver_secret:
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self.send_error(400)
                return
            if length <= 0 or length > MAX_BODY:
                self.send_error(413)
                return
            body = self.rfile.read(length)
            if not verify_signature(deliver_secret, body, self.headers.get("X-SubEtha-Signature")):
                self.send_error(401)
                return
            try:
                data = json.loads(body)
                dest, msg = data["destination"], data["message"]
                if not isinstance(dest, str) or len(dest) != 32 or not isinstance(msg, dict):
                    raise ValueError("bad payload")
                int(dest, 16)
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            try:
                deliver(dest.lower(), msg)
            except Exception:  # noqa: BLE001
                self.send_error(503)
                return
            self.send_response(204)
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path not in ("/", "/health", "/healthz"):
                self.send_error(404)
                return
            body = json.dumps(status()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, name="health", daemon=True).start()
    return server
