"""The message envelope (spec §2) plus validation, E2EE (§5), and dedupe (§6).

Mirrors sdk/js/src/protocol/envelope.ts.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import OrderedDict
from typing import Any, Callable

from .canonical import MAX_SAFE_INTEGER, CanonicalError, canonical_envelope, canonicalize
from .encoding import base64url_decode, base64url_encode
from .sign import DEVICE_ID_RE
from .topic import TOPIC_RE
from .ulid import ULID_RE
from .xchacha import xchacha_open, xchacha_seal

TRANSPORTS = (
    "ws", "sse", "poll", "webpush", "apns", "fcm", "webhook", "email", "slack",
    "sms", "voice", "mcp", "lxmf", "ble", "audio", "qr", "lan",
)
EDGE_TRANSPORTS = ("ble", "audio", "qr", "lan")
ROUTE_MODES = ("any", "fast", "all", "cheap")
EVENTS = ("message", "open", "keepalive", "poll_request")
CONTENT_TYPES = ("text/plain", "text/markdown", "application/json", "application/octet-stream")
MAX_MESSAGE_BYTES = 4096

_SIG_RE = re.compile(r"ed25519:[A-Za-z0-9_-]{86}")
_NONCE_RE = re.compile(r"[A-Za-z0-9_-]{32}")

Envelope = dict[str, Any]


def _is_int(v: object, lo: float = float("-inf"), hi: float = float("inf")) -> bool:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    if isinstance(v, float) and not v.is_integer():
        return False
    return -MAX_SAFE_INTEGER <= v <= MAX_SAFE_INTEGER and lo <= v <= hi


def _is_str(v: object, max_bytes: float = float("inf")) -> bool:
    if not isinstance(v, str):
        return False
    try:
        return len(v.encode("utf-8")) <= max_bytes
    except UnicodeEncodeError:  # lone surrogates
        return False


def _transports_ok(r: dict[str, Any], key: str) -> bool:
    if key not in r:
        return True
    a = r[key]
    return isinstance(a, list) and all(t in TRANSPORTS for t in a)


def _action_ok(a: object) -> bool:
    return isinstance(a, dict) and a.get("action") in ("view", "http", "broadcast") and isinstance(a.get("label"), str)


def _enc_ok(v: object) -> bool:
    return (
        isinstance(v, dict)
        and v.get("alg") == "xchacha20poly1305"
        and isinstance(v.get("kid"), str)
        and isinstance(v.get("nonce"), str)
        and _NONCE_RE.fullmatch(v["nonce"]) is not None
    )


def _route_ok(v: object) -> bool:
    if not isinstance(v, dict):
        return False
    return (
        ("mode" not in v or v["mode"] in ROUTE_MODES)
        and ("max_cost_usd_micros" not in v or _is_int(v["max_cost_usd_micros"], 0))
        and ("deadline_s" not in v or _is_int(v["deadline_s"], 1))
        and _transports_ok(v, "deny")
        and _transports_ok(v, "allow")
    )


_CHECKS: list[tuple[str, Callable[[Any], bool], str]] = [
    ("id", lambda v: isinstance(v, str) and ULID_RE.fullmatch(v) is not None, "must be a ULID"),
    ("time", lambda v: _is_int(v, 0), "must be a non-negative integer"),
    ("expires", lambda v: _is_int(v, 0), "must be a non-negative integer"),
    ("event", lambda v: v in EVENTS, "unknown event"),
    ("title", lambda v: _is_str(v, 256), "string up to 256 bytes"),
    ("message", lambda v: _is_str(v, MAX_MESSAGE_BYTES), f"string up to {MAX_MESSAGE_BYTES} bytes"),
    ("priority", lambda v: _is_int(v, 1, 5), "integer 1..5"),
    ("tags", lambda v: isinstance(v, list) and len(v) <= 16 and all(_is_str(t, 64) for t in v), "up to 16 strings"),
    ("click", lambda v: _is_str(v, 2048), "string"),
    ("icon", lambda v: _is_str(v, 2048), "string"),
    ("actions", lambda v: isinstance(v, list) and len(v) <= 3 and all(_action_ok(a) for a in v),
     "up to 3 actions with action and label"),
    ("attachment", lambda v: isinstance(v, dict) and isinstance(v.get("name"), str) and isinstance(v.get("url"), str),
     "needs name and url"),
    ("content_type", lambda v: v in CONTENT_TYPES, "unsupported content type"),
    ("sender", lambda v: isinstance(v, str) and DEVICE_ID_RE.fullmatch(v) is not None, "must be a device id"),
    ("sig", lambda v: isinstance(v, str) and _SIG_RE.fullmatch(v) is not None, "must be ed25519:<base64url>"),
    ("enc", _enc_ok, "invalid enc block"),
    ("route", _route_ok, "invalid route block"),
    ("hops", lambda v: _is_int(v, 0, 16), "integer 0..16"),
]


def validate_envelope(env: object) -> list[str]:
    """Validates an envelope against the v0 schema. Returns a list of problems (empty = valid)."""
    if not isinstance(env, dict):
        return ["envelope must be an object"]
    errs: list[str] = []
    topic = env.get("topic")
    if not isinstance(topic, str) or TOPIC_RE.fullmatch(topic) is None:
        errs.append("topic: invalid topic name")
    for key, ok, why in _CHECKS:
        v = env.get(key)
        if v is not None and not ok(v):
            errs.append(f"{key}: {why}")
    # Integers only, anywhere (spec §2).
    try:
        canonicalize(env)
    except CanonicalError as e:
        errs.append(f"envelope: {e}")
    return errs


PRIORITY_NAMES = {"min": 1, "low": 2, "default": 3, "high": 4, "max": 5, "urgent": 5}


def parse_priority(v: str | int | None) -> int | None:
    """Parses an ntfy priority (1-5 or a name). Returns None for empty input."""
    if v is None or v == "":
        return None
    if isinstance(v, int) and not isinstance(v, bool):
        if 1 <= v <= 5:
            return v
        raise ValueError(f"invalid priority: {v}")
    s = str(v).strip().lower()
    if s in PRIORITY_NAMES:
        return PRIORITY_NAMES[s]
    try:
        n = float(s)
    except ValueError:
        raise ValueError(f"invalid priority: {v}") from None
    if n.is_integer() and 1 <= n <= 5:
        return int(n)
    raise ValueError(f"invalid priority: {v}")


# ---- E2EE (spec §5) ----

PROTECTED_FIELDS = ("title", "message", "attachment", "click", "actions", "content_type")


def encrypt_envelope(env: Envelope, key: bytes, kid: str, nonce: bytes | None = None) -> Envelope:
    """Encrypts the protected fields. Drops any existing ``sig``; sign after encrypting."""
    if env.get("enc"):
        raise ValueError("already encrypted")
    n = os.urandom(24) if nonce is None else bytes(nonce)
    prot: dict[str, Any] = {}
    out = dict(env)
    for f in PROTECTED_FIELDS:
        if f in env:
            prot[f] = env[f]
            del out[f]
    out.pop("sig", None)
    out["enc"] = {"alg": "xchacha20poly1305", "kid": kid, "nonce": base64url_encode(n)}
    aad = canonical_envelope(out).encode("utf-8")
    ct = xchacha_seal(key, n, canonicalize(prot).encode("utf-8"), aad)
    out["message"] = base64url_encode(ct)
    return out


def decrypt_envelope(env: Envelope, key: bytes) -> Envelope | None:
    """Returns the decrypted envelope, or None if the key is wrong or the message was tampered with."""
    enc = env.get("enc")
    message = env.get("message")
    if not enc or not isinstance(message, str):
        return None
    rest = {k: v for k, v in env.items() if k != "message"}
    try:
        aad = canonical_envelope(rest).encode("utf-8")
        pt = xchacha_open(key, base64url_decode(enc["nonce"]), base64url_decode(message), aad)
        if pt is None:
            return None
        prot = json.loads(pt.decode("utf-8"))
    except (ValueError, KeyError, TypeError):
        return None
    out = {**rest, **prot}
    out.pop("enc", None)
    return out


# ---- Dedupe (spec §6) ----


class Deduper:
    """Drops messages whose id was already seen, or whose ``expires`` has passed.

    Thread-safe. Keeps the most recent ``capacity`` ids (first-in, first-out).
    """

    def __init__(self, capacity: int = 10_000) -> None:
        self.capacity = capacity
        self._seen: OrderedDict[str, int] = OrderedDict()
        self._lock = threading.Lock()

    def accept(self, env: dict[str, Any], now_sec: int | None = None) -> bool:
        """Returns True if the message is new and should be delivered."""
        now = int(time.time()) if now_sec is None else now_sec
        expires = env.get("expires")
        if expires is not None and expires < now:
            return False
        id_ = env.get("id")
        if not id_:
            return True
        id_ = str(id_).upper()
        with self._lock:
            if id_ in self._seen:
                return False
            self._seen[id_] = expires if expires is not None else MAX_SAFE_INTEGER
            if len(self._seen) > self.capacity:
                self._seen.popitem(last=False)
        return True

    def has(self, id_: str) -> bool:
        with self._lock:
            return id_.upper() in self._seen

    def __len__(self) -> int:
        return len(self._seen)

    @property
    def size(self) -> int:
        return len(self._seen)
