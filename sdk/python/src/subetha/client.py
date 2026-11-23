"""HTTP client for the SubEtha relay (spec §8, ntfy-compatible)."""

from __future__ import annotations

import json
import threading
import time
from decimal import Decimal
from typing import Any, Iterator, Mapping, Sequence

import httpx

from . import __version__
from .errors import SubEthaError
from .protocol import (
    ROUTE_MODES,
    TRANSPORTS,
    Deduper,
    DeviceKey,
    is_topic,
    parse_priority,
    sign_envelope,
    sign_request,
    ulid,
    unwrap_topic_key,
    validate_envelope,
    wrap_topic_key,
)

DEFAULT_BASE_URL = "https://subetha.org"


class DeviceAuth(httpx.Auth):
    """Signs every request with an enrolled device's key (spec §8.1, ``subetha-req-v2``) instead
    of sending a bearer token. Usable on any ``httpx.Client``: ``httpx.Client(auth=DeviceAuth(key))``.
    """

    requires_request_body = True

    def __init__(self, key: DeviceKey, clock: Any = None) -> None:
        self.key = key
        self.clock = clock or (lambda: int(time.time()))

    def auth_flow(self, request: httpx.Request) -> Iterator[httpx.Request]:
        request.headers.pop("authorization", None)
        signed = sign_request(self.key, request.method, str(request.url), request.content, request.headers.multi_items(), self.clock())
        request.headers.update(signed)
        yield request

#: Read timeout for streaming subscriptions. ntfy-style servers send a keepalive at least every
#: 45-55 seconds, so a silent connection beyond this is treated as dead and reconnected.
STREAM_READ_TIMEOUT = 90.0


def _topic_path(topic: str | Sequence[str]) -> str:
    topics = [topic] if isinstance(topic, str) else list(topic)
    parts: list[str] = []
    for t in topics:
        parts.extend(t.split(","))
    if not parts:
        raise ValueError("at least one topic is required")
    for t in parts:
        if not is_topic(t):
            raise ValueError(f"invalid topic: {t!r}")
    return ",".join(parts)


def _normalize_route(route: str | Mapping[str, Any] | None) -> dict[str, Any] | None:
    if route is None:
        return None
    r = {"mode": route} if isinstance(route, str) else {k: v for k, v in route.items() if v is not None}
    if "mode" in r and r["mode"] not in ROUTE_MODES:
        raise ValueError(f"invalid route mode: {r['mode']!r}")
    for key in ("deny", "allow"):
        if key in r:
            if isinstance(r[key], str):
                r[key] = [t.strip() for t in r[key].split(",") if t.strip()]
            bad = [t for t in r[key] if t not in TRANSPORTS]
            if bad:
                raise ValueError(f"unknown transport(s) in route.{key}: {bad}")
            r[key] = list(r[key])
    return r or None


def _route_headers(route: Mapping[str, Any]) -> dict[str, str]:
    h: dict[str, str] = {}
    if "mode" in route:
        h["X-Route-Mode"] = route["mode"]
    if "max_cost_usd_micros" in route:
        usd = Decimal(int(route["max_cost_usd_micros"])) / Decimal(1_000_000)
        h["X-Max-Cost"] = format(usd.normalize(), "f")
    if route.get("deny"):
        h["X-Deny"] = ",".join(route["deny"])
    if route.get("allow"):
        h["X-Allow"] = ",".join(route["allow"])
    if "deadline_s" in route:
        h["X-Deadline"] = str(int(route["deadline_s"]))
    return h


def _header_safe(s: str) -> bool:
    return s.isascii() and "\r" not in s and "\n" not in s


class Client:
    """A synchronous SubEtha client.

    >>> c = Client(token="tk_...")
    >>> c.publish("@alice/doorbell", "Opened", title="Front door", priority="high")
    >>> for msg in c.subscribe("@alice/doorbell"):
    ...     print(msg["message"])

    Pass ``transport`` (e.g. ``httpx.MockTransport``) or a ready ``http_client`` for testing.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        token: str | None = None,
        *,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
        http_client: httpx.Client | None = None,
        user_agent: str | None = None,
        device_key: DeviceKey | None = None,
        sign_requests: bool = False,
    ) -> None:
        """``sign_requests=True`` authenticates every request with ``device_key`` (an enrolled
        device, spec §8.1) instead of ``token``."""
        if sign_requests and device_key is None:
            raise ValueError("sign_requests needs a device_key")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.device_key = device_key
        headers = {"User-Agent": user_agent or f"subetha-python/{__version__}"}
        if token and not sign_requests:
            headers["Authorization"] = f"Bearer {token}"
        auth = DeviceAuth(device_key) if sign_requests and device_key is not None else None
        if http_client is not None:
            self._http = http_client
            self._http.headers.update(headers)
            if auth is not None:
                self._http.auth = auth
            self._owns_http = False
        else:
            self._http = httpx.Client(base_url=self.base_url, headers=headers, timeout=timeout, transport=transport, auth=auth)
            self._owns_http = True
        #: Used between reconnect attempts; replaceable in tests.
        self.sleep = time.sleep

    # -- lifecycle --

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- publish --

    def publish(
        self,
        topic: str,
        message: str,
        title: str | None = None,
        priority: int | str | None = None,
        tags: Sequence[str] | None = None,
        route: str | Mapping[str, Any] | None = None,
        dry_run: bool = False,
        idempotency_key: str | None = None,
        sign_with: DeviceKey | None = None,
        *,
        id: str | None = None,
        click: str | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Publishes a message and returns the relay's JSON response (the stored envelope).

        Simple messages use ntfy headers (``POST /<topic>``). Signed messages, messages with
        extension fields (``extra``), and titles/tags that can't travel in an HTTP header use the
        JSON form (``POST /``). ``route`` is a mode string or a dict with ``mode``,
        ``max_cost_usd_micros``, ``deny``, ``allow``, ``deadline_s``.
        """
        if not is_topic(topic):
            raise ValueError(f"invalid topic: {topic!r}")
        if not isinstance(message, str):
            raise TypeError("message must be a str")
        prio = parse_priority(priority)
        tag_list = [str(t) for t in tags] if tags else None
        r = _normalize_route(route)

        headers: dict[str, str] = {}
        if dry_run:
            headers["X-Dry-Run"] = "1"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        header_ok = (title is None or _header_safe(title)) and all(_header_safe(t) and "," not in t for t in tag_list or [])
        if click is not None and not _header_safe(click):
            header_ok = False

        if sign_with is None and not extra and header_ok:
            if title is not None:
                headers["X-Title"] = title
            if prio is not None:
                headers["X-Priority"] = str(prio)
            if tag_list:
                headers["X-Tags"] = ",".join(tag_list)
            if click is not None:
                headers["X-Click"] = click
            if id is not None:
                headers["X-Message-Id"] = id
            if r:
                headers.update(_route_headers(r))
            headers["Content-Type"] = "text/plain; charset=utf-8"
            resp = self._http.post(f"/{topic}", content=message.encode("utf-8"), headers=headers)
            return self._json(resp)

        env: dict[str, Any] = {}
        if extra:
            env.update(extra)
        env["topic"] = topic
        env["message"] = message
        if title is not None:
            env["title"] = title
        if prio is not None and prio != 3:
            env["priority"] = prio
        if tag_list:
            env["tags"] = tag_list
        if click is not None:
            env["click"] = click
        if r:
            env["route"] = r
        if id is not None:
            env["id"] = id
        if sign_with is not None:
            env.setdefault("id", ulid())
            env.setdefault("time", int(time.time()))
            env = sign_envelope(env, sign_with)
        problems = validate_envelope(env)
        if problems:
            raise ValueError("invalid envelope: " + "; ".join(problems))
        headers["Content-Type"] = "application/json"
        body = json.dumps(env, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        resp = self._http.post("/", content=body, headers=headers)
        return self._json(resp)

    # -- poll / subscribe --

    def poll(self, topic: str | Sequence[str], since: str | int | None = None) -> list[dict[str, Any]]:
        """Returns cached messages (``GET /<topic>/json?poll=1``)."""
        params: dict[str, str] = {"poll": "1"}
        if since is not None:
            params["since"] = str(since)
        resp = self._http.get(f"/{_topic_path(topic)}/json", params=params)
        if resp.status_code >= 400:
            raise SubEthaError.from_response(resp)
        out = []
        for line in resp.text.splitlines():
            msg = _parse_line(line)
            if msg is not None and msg.get("event", "message") == "message":
                out.append(msg)
        return out

    def subscribe(
        self,
        topic: str | Sequence[str],
        since: str | int | None = None,
        *,
        dedupe: bool | Deduper = True,
        reconnect: bool = True,
        max_reconnects: int | None = None,
        retry_delay: float = 1.0,
        max_retry_delay: float = 30.0,
        stop: threading.Event | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yields messages from the NDJSON stream (``GET /<topic>/json``).

        Drops duplicates by id (spec §6) and, when the connection ends or fails, reconnects
        with ``since=<last id>`` using exponential backoff. Client errors (4xx other than 429)
        are raised. ``max_reconnects`` caps the total number of reconnects (None = forever).
        Set ``stop`` to end the generator at the next line or reconnect.
        """
        path = f"/{_topic_path(topic)}/json"
        deduper = dedupe if isinstance(dedupe, Deduper) else (Deduper() if dedupe else None)
        last: str | int | None = since
        failures = 0  # consecutive failed or empty connections, for backoff
        reconnects = 0  # total, for max_reconnects
        timeout = httpx.Timeout(self._http.timeout.connect or 30.0, read=STREAM_READ_TIMEOUT)
        while True:
            if stop is not None and stop.is_set():
                return
            params = {"since": str(last)} if last is not None else {}
            error: Exception | None = None
            delay_hint: float | None = None
            try:
                with self._http.stream("GET", path, params=params, timeout=timeout) as resp:
                    if resp.status_code >= 400:
                        resp.read()
                        err = SubEthaError.from_response(resp)
                        if not err.retryable:
                            raise err
                        error, delay_hint = err, err.retry_after
                    else:
                        for line in resp.iter_lines():
                            if stop is not None and stop.is_set():
                                return
                            msg = _parse_line(line)
                            if msg is None:
                                continue
                            if msg.get("event", "message") != "message":
                                continue
                            failures = 0
                            if deduper is not None and not deduper.accept(msg):
                                continue
                            if msg.get("id"):
                                last = msg["id"]  # only advance on new messages
                            yield msg
            except httpx.TransportError as e:
                error = e
            if not reconnect:
                if error is not None:
                    raise error
                return
            failures += 1
            reconnects += 1
            if max_reconnects is not None and reconnects > max_reconnects:
                if error is not None:
                    raise error
                return
            delay = delay_hint if delay_hint is not None else min(max_retry_delay, retry_delay * 2 ** (failures - 1))
            if stop is not None:
                if stop.wait(delay):
                    return
            elif delay > 0:
                self.sleep(delay)

    # -- wrapped topic keys (spec §5.1) --

    def share_topic_key(self, topic: str, kid: str, key: bytes, device_ids: Sequence[str]) -> int:
        """Wraps ``key`` for each device and uploads the wrapped keys (``PUT /v1/keys``). Needs an
        admin token for a topic you own. Returns how many were stored."""
        wrapped = [wrap_topic_key(key, topic, kid, d) for d in device_ids]
        stored = 0
        for i in range(0, len(wrapped), 100):
            stored += int(self._json(self._http.put("/v1/keys", json={"keys": wrapped[i : i + 100]})).get("stored", 0))
        return stored

    def list_wrapped_keys(self, topic: str | None = None) -> list[dict[str, Any]]:
        """As a device, the wrapped keys addressed to it; as an admin, all of your topics'."""
        return list(self._json(self._http.get("/v1/keys", params={"topic": topic} if topic else None)).get("keys", []))

    def load_topic_keys(self, topic: str | None = None, device_key: DeviceKey | None = None) -> dict[str, tuple[str, bytes]]:
        """Fetches and opens the wrapped keys addressed to this device. Returns ``{topic: (kid,
        key)}`` with the newest key per topic, ready for ``decrypt_envelope``/``encrypt_envelope``."""
        dk = device_key or self.device_key
        if dk is None:
            raise ValueError("load_topic_keys needs a device_key")
        best: dict[str, tuple[int, str, bytes]] = {}
        for w in self.list_wrapped_keys(topic):
            at = int(w.pop("created_at", 0))
            if w.get("to") != dk.device_id:
                continue
            key = unwrap_topic_key(w, dk)
            if key is not None and (w["topic"] not in best or at >= best[w["topic"]][0]):
                best[w["topic"]] = (at, w["kid"], key)
        return {t: (kid, key) for t, (_, kid, key) in best.items()}

    # -- helpers --

    @staticmethod
    def _json(resp: httpx.Response) -> dict[str, Any]:
        if resp.status_code >= 400:
            raise SubEthaError.from_response(resp)
        if not resp.content:
            return {}
        try:
            data = resp.json()
        except ValueError:
            return {"raw": resp.text}
        return data if isinstance(data, dict) else {"result": data}


def _parse_line(line: str) -> dict[str, Any] | None:
    line = line.strip()
    if not line:
        return None
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    return msg if isinstance(msg, dict) else None
