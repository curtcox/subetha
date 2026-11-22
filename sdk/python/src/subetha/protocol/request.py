"""Device-signed HTTP requests (spec §8.1, ``subetha-req-v2``). Mirrors sdk/js/src/protocol/request.ts."""

from __future__ import annotations

import hashlib
import os
import re
import time as _time
from typing import Iterable, Mapping
from urllib.parse import urlsplit

from .encoding import base64url_encode
from .sign import DeviceKey

REQ_V2_DOMAIN = "subetha-req-v2"
REQUIRED_SIGNED_HEADERS = ("x-device-id", "x-device-time", "x-device-nonce")
MAX_SIGNED_HEADERS = 32

#: Headers a relay refuses to accept unsigned on a device-signed request.
COVERED_REQUEST_HEADERS = frozenset({
    "content-type", "content-encoding", "idempotency-key",
    "x-title", "title", "t",
    "x-priority", "priority", "prio", "p",
    "x-tags", "tags", "tag", "ta",
    "x-click", "click",
    "x-icon", "icon",
    "x-attach", "attach", "a",
    "x-markdown", "markdown", "md",
    "x-actions", "actions", "action",
    "x-filename", "filename", "file", "f",
    "x-message", "message", "m",
    "x-delay", "delay", "x-at", "at", "x-in", "in",
    "x-email", "email", "e", "x-call", "call",
    "x-cache", "cache", "x-firebase", "firebase", "x-unifiedpush", "unifiedpush", "up",
    "x-poll-id", "poll-id",
    "x-sender", "x-signature", "x-message-id", "x-time", "x-expires",
    "x-route-mode", "x-max-cost", "x-deny", "x-allow", "x-deadline", "x-dry-run",
})

#: Headers the SDKs don't sign: credentials, and headers HTTP stacks set or rewrite themselves.
UNSIGNED_BY_CONVENTION = frozenset({
    "authorization", "host", "content-length", "connection", "transfer-encoding", "user-agent", "accept", "accept-encoding",
})

_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_DEFAULT_PORTS = {"http": 80, "ws": 80, "https": 443, "wss": 443}


def url_host_and_path(url: str) -> tuple[str, str]:
    """WHATWG ``URL.host`` (lowercase, ``:port`` only if not the default) and ``pathname + search``."""
    u = urlsplit(url)
    host = (u.hostname or "").lower()
    if ":" in host:
        host = f"[{host}]"
    if u.port is not None and u.port != _DEFAULT_PORTS.get(u.scheme.lower()):
        host = f"{host}:{u.port}"
    path = u.path or "/"
    return host, path + (f"?{u.query}" if u.query else "")


def _trim(v: str) -> str:
    return v.strip(" \t")


def request_signing_input(method: str, url: str, body: bytes, signed_headers: Iterable[tuple[str, str]]) -> str:
    """``subetha-req-v2\\nMETHOD\\nhost\\npath?query\\nhex(sha256(body))`` then ``\\nname:value`` per header."""
    host, path = url_host_and_path(url)
    s = f"{REQ_V2_DOMAIN}\n{method.upper()}\n{host}\n{path}\n{hashlib.sha256(body).hexdigest()}"
    for name, value in signed_headers:
        s += f"\n{name.lower()}:{_trim(value)}"
    return s


def headers_to_sign(device_id: str, time: int, nonce: str, headers: Mapping[str, str] | Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    """The SDK convention: X-Device-Id, -Time, -Nonce, then the other headers lowercased and sorted."""
    items = headers.items() if isinstance(headers, Mapping) else headers
    rest: dict[str, str] = {}
    for k, v in items:
        n = k.lower()
        if n in UNSIGNED_BY_CONVENTION or n.startswith("x-device-"):
            continue
        rest[n] = v
    return [("x-device-id", device_id), ("x-device-time", str(time)), ("x-device-nonce", nonce)] + sorted(rest.items())


def new_request_nonce() -> str:
    return base64url_encode(os.urandom(16))


def sign_request(
    key: DeviceKey,
    method: str,
    url: str,
    body: bytes = b"",
    headers: Mapping[str, str] | Iterable[tuple[str, str]] = (),
    time: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """``X-Device-*`` headers for one request. ``headers`` are the headers the request will carry."""
    nonce = nonce or new_request_nonce()
    if not _NONCE_RE.match(nonce):
        raise ValueError("nonce must be 16-64 base64url characters")
    t = int(_time.time()) if time is None else time
    signed = headers_to_sign(key.device_id, t, nonce, headers)
    if len(signed) > MAX_SIGNED_HEADERS:
        raise ValueError(f"at most {MAX_SIGNED_HEADERS} signed headers")
    sig = key.sign(request_signing_input(method, url, body, signed).encode("utf-8"))
    return {
        "X-Device-Id": key.device_id,
        "X-Device-Time": str(t),
        "X-Device-Nonce": nonce,
        "X-Device-Signed-Headers": ",".join(n for n, _ in signed),
        "X-Device-Signature": base64url_encode(sig),
    }
