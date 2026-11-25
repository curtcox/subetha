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
    decrypt_envelope,
    encrypt_envelope,
    enrollment_proof,
    is_topic,
    parse_priority,
    sign_envelope,
    sign_request,
    ulid,
    unwrap_topic_key,
    validate_envelope,
    verify_envelope,
    wrap_topic_key,
)

DEFAULT_BASE_URL = "https://subetha.us"


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

class DbaAuth(httpx.Auth):
    """Authenticates every request as a devicebasedauth.org device: ``dba`` is anything with
    ``headers(method, url)`` (or a callable ``(method, url)``) returning that request's
    ``Authorization: DBA …`` and ``DPoP`` headers, such as a wrapper around ``dba headers METHOD URL``.
    """

    def __init__(self, dba: Any) -> None:
        self.dba = dba

    def auth_flow(self, request: httpx.Request) -> Iterator[httpx.Request]:
        request.headers.pop("authorization", None)
        get = getattr(self.dba, "headers", self.dba)
        request.headers.update(dict(get(request.method, str(request.url))))
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

    >>> c = Client(token="se_...")
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
        topic_keys: Mapping[str, tuple[str, bytes]] | None = None,
        dba: Any = None,
    ) -> None:
        """``sign_requests=True`` authenticates every request with ``device_key`` (a signing key
        attached with ``attach_device_key``, spec §8.1) instead of ``token``. ``dba`` authenticates
        every request as a devicebasedauth.org device instead (see ``DbaAuth``)."""
        if sign_requests and device_key is None:
            raise ValueError("sign_requests needs a device_key")
        if sign_requests and dba is not None:
            raise ValueError("use either sign_requests or dba, not both")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.device_key = device_key
        self.topic_keys: dict[str, tuple[str, bytes]] = {}
        if topic_keys:
            for t, kv in topic_keys.items():
                self.set_topic_key(t, kv)
        headers = {"User-Agent": user_agent or f"subetha-python/{__version__}"}
        if token and not sign_requests and dba is None:
            headers["Authorization"] = f"Bearer {token}"
        auth: httpx.Auth | None = DeviceAuth(device_key) if sign_requests and device_key is not None else DbaAuth(dba) if dba is not None else None
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
        icon: str | None = None,
        actions: Sequence[Mapping[str, Any]] | None = None,
        content_type: str | None = None,
        expires: int | None = None,
        hops: int | None = None,
        encrypt: bool | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Publishes a message and returns the relay's JSON response (the stored envelope).

        Simple messages use ntfy headers (``POST /<topic>``). Signed/encrypted messages, messages
        with extension fields (``extra``), and titles/tags that can't travel in an HTTP header use
        the JSON form (``POST /``). ``route`` is a mode string or a dict with ``mode``,
        ``max_cost_usd_micros``, ``deny``, ``allow``, ``deadline_s``.
        """
        if not is_topic(topic):
            raise ValueError(f"invalid topic: {topic!r}")
        if not isinstance(message, str):
            raise TypeError("message must be a str")
        prio = parse_priority(priority)
        tag_list = [str(t) for t in tags] if tags else None
        r = _normalize_route(route)
        tk = self.topic_keys.get(topic)
        do_encrypt = (tk is not None) if encrypt is None else bool(encrypt)
        if do_encrypt and tk is None:
            raise ValueError(f"no E2EE topic key set for {topic}")

        headers: dict[str, str] = {}
        if dry_run:
            headers["X-Dry-Run"] = "1"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        header_ok = (title is None or _header_safe(title)) and all(_header_safe(t) and "," not in t for t in tag_list or [])
        if click is not None and not _header_safe(click):
            header_ok = False
        if icon is not None and not _header_safe(icon):
            header_ok = False

        if sign_with is None and not do_encrypt and not extra and not actions and header_ok:
            if title is not None:
                headers["X-Title"] = title
            if prio is not None:
                headers["X-Priority"] = str(prio)
            if tag_list:
                headers["X-Tags"] = ",".join(tag_list)
            if click is not None:
                headers["X-Click"] = click
            if icon is not None:
                headers["X-Icon"] = icon
            if content_type is not None:
                headers["X-Content-Type"] = content_type
            if expires is not None:
                headers["X-Expires"] = str(int(expires))
            if hops is not None:
                headers["X-Hops"] = str(int(hops))
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
        if icon is not None:
            env["icon"] = icon
        if actions is not None:
            env["actions"] = [dict(a) for a in actions]
        if content_type is not None:
            env["content_type"] = content_type
        if expires is not None:
            env["expires"] = int(expires)
        if hops is not None:
            env["hops"] = int(hops)
        if r:
            env["route"] = r
        if id is not None:
            env["id"] = id
        if do_encrypt or sign_with is not None:
            env.setdefault("id", ulid())
            env.setdefault("time", int(time.time()))
        if do_encrypt and tk is not None:
            kid, key = tk
            env = encrypt_envelope(env, key, kid)
        if sign_with is not None:
            env = sign_envelope(env, sign_with)
        problems = validate_envelope(env)
        if problems:
            raise ValueError("invalid envelope: " + "; ".join(problems))
        headers["Content-Type"] = "application/json"
        body = json.dumps(env, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        resp = self._http.post("/", content=body, headers=headers)
        return self._json(resp)

    def publish_envelope(self, env: Mapping[str, Any], *, idempotency_key: str | None = None) -> dict[str, Any]:
        """Publishes a pre-built envelope (e.g. forwarded from an edge link) without rewriting it."""
        payload = {k: v for k, v in env.items() if k != "event"}
        headers = {"Content-Type": "application/json"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return self._json(self._http.post("/", content=body, headers=headers))

    def estimate(self, topic: str, message: str = "test", **kwargs: Any) -> dict[str, Any]:
        """Dry-run cost estimate and delivery plan for ``publish``."""
        kwargs["dry_run"] = True
        return self.publish(topic, message, **kwargs)

    def publish_file(
        self,
        topic: str,
        filename: str,
        data: bytes,
        *,
        content_type: str = "application/octet-stream",
        message: str | None = None,
        title: str | None = None,
        priority: int | str | None = None,
        tags: Sequence[str] | None = None,
        click: str | None = None,
        icon: str | None = None,
        actions: Sequence[Mapping[str, Any]] | None = None,
        expires: int | None = None,
        markdown: bool = False,
        route: str | Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Uploads a file attachment to R2 and publishes a message referencing it (``PUT /<topic>``)."""
        if not is_topic(topic):
            raise ValueError(f"invalid topic: {topic!r}")
        headers: dict[str, str] = {"Content-Type": content_type, "X-Filename": filename}
        if message is not None:
            headers["X-Message"] = message
        if title is not None:
            headers["X-Title"] = title
        prio = parse_priority(priority)
        if prio is not None and prio != 3:
            headers["X-Priority"] = str(prio)
        if tags:
            headers["X-Tags"] = ",".join(str(t) for t in tags)
        if click is not None:
            headers["X-Click"] = click
        if icon is not None:
            headers["X-Icon"] = icon
        if actions is not None:
            headers["X-Actions"] = json.dumps([dict(a) for a in actions], separators=(",", ":"))
        if expires is not None:
            headers["X-Expires"] = str(int(expires))
        if markdown:
            headers["X-Markdown"] = "1"
        r = _normalize_route(route)
        if r:
            headers.update(_route_headers(r))
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if dry_run:
            headers["X-Dry-Run"] = "1"
        return self._json(self._http.put(f"/{topic}", content=data, headers=headers))

    def estimate_file(self, topic: str, filename: str, data: bytes, **kwargs: Any) -> dict[str, Any]:
        """Dry-run cost estimate for ``publish_file``."""
        return self.publish_file(topic, filename, data, dry_run=True, **kwargs)

    def ack(self, topic: str, message_id: str, via: str = "python") -> dict[str, Any]:
        """Acknowledges a received message so escalation stops (``POST /v1/ack``)."""
        return self._json(self._http.post("/v1/ack", json={"topic": topic, "id": message_id, "via": via}))

    # -- poll / subscribe --

    def _process_incoming(self, msg: dict[str, Any], *, verify: bool, require_signature: bool, raw: bool) -> dict[str, Any] | None:
        if require_signature and not msg.get("sig"):
            return None
        if (verify or require_signature) and msg.get("sig") and not verify_envelope(msg):
            return None
        if not raw and msg.get("enc") and isinstance(msg.get("topic"), str):
            tk = self.topic_keys.get(msg["topic"])
            if tk is not None:
                opened = decrypt_envelope(msg, tk[1])
                if opened is not None:
                    return opened
        return msg

    def poll(
        self,
        topic: str | Sequence[str],
        since: str | int | None = None,
        *,
        priority: Sequence[int] | None = None,
        tags: Sequence[str] | None = None,
        verify: bool = False,
        require_signature: bool = False,
        raw: bool = False,
    ) -> list[dict[str, Any]]:
        """Returns cached messages (``GET /<topic>/json?poll=1``)."""
        params: dict[str, str] = {"poll": "1"}
        if since is not None:
            params["since"] = str(since)
        if priority:
            params["priority"] = ",".join(str(p) for p in priority)
        if tags:
            params["tags"] = ",".join(str(t) for t in tags)
        resp = self._http.get(f"/{_topic_path(topic)}/json", params=params)
        if resp.status_code >= 400:
            raise SubEthaError.from_response(resp)
        out = []
        for line in resp.text.splitlines():
            msg = _parse_line(line)
            if msg is not None and msg.get("event", "message") == "message":
                processed = self._process_incoming(msg, verify=verify, require_signature=require_signature, raw=raw)
                if processed is not None:
                    out.append(processed)
        return out

    def subscribe(
        self,
        topic: str | Sequence[str],
        since: str | int | None = None,
        *,
        priority: Sequence[int] | None = None,
        tags: Sequence[str] | None = None,
        dedupe: bool | Deduper = True,
        reconnect: bool = True,
        max_reconnects: int | None = None,
        retry_delay: float = 1.0,
        max_retry_delay: float = 30.0,
        auto_ack: bool = False,
        verify: bool = False,
        require_signature: bool = False,
        raw: bool = False,
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
            params: dict[str, str] = {}
            if last is not None:
                params["since"] = str(last)
            if priority:
                params["priority"] = ",".join(str(p) for p in priority)
            if tags:
                params["tags"] = ",".join(str(t) for t in tags)
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
                            processed = self._process_incoming(msg, verify=verify, require_signature=require_signature, raw=raw)
                            if processed is None:
                                continue
                            if auto_ack and processed.get("id") and processed.get("topic"):
                                try:
                                    self.ack(str(processed["topic"]), str(processed["id"]), "stream")
                                except Exception:
                                    pass
                            yield processed
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

    def set_topic_key(self, topic: str, key_pair: tuple[str, bytes] | None) -> None:
        """Sets or clears the E2EE ``(kid, 32-byte key)`` used automatically for ``topic``."""
        if key_pair is None:
            self.topic_keys.pop(topic, None)
            return
        kid, key = key_pair
        if len(key) != 32:
            raise ValueError("topic key must be 32 bytes")
        self.topic_keys[topic] = (kid, key)

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

    def delete_wrapped_keys(self, topic: str, *, kid: str | None = None, device: str | None = None) -> int:
        """Deletes wrapped keys for a topic, optionally narrowed by ``kid`` and/or ``device``."""
        params: dict[str, str] = {"topic": topic}
        if kid is not None:
            params["kid"] = kid
        if device is not None:
            params["device"] = device
        return int(self._json(self._http.delete("/v1/keys", params=params)).get("deleted", 0))

    def load_topic_keys(self, topic: str | None = None, device_key: DeviceKey | None = None) -> dict[str, tuple[str, bytes]]:
        """Fetches and opens the wrapped keys addressed to this device, storing them in
        ``self.topic_keys`` for automatic E2EE on subsequent publish/poll/subscribe calls."""
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
        loaded = {t: (kid, key) for t, (_, kid, key) in best.items()}
        self.topic_keys.update(loaded)
        return loaded

    # -- control plane --

    def account(self) -> dict[str, Any]:
        return self._json(self._http.get("/v1/account"))

    def update_account(self, **body: Any) -> dict[str, Any]:
        return self._json(self._http.patch("/v1/account", json=body))

    def balance(self) -> dict[str, Any]:
        return self._json(self._http.get("/v1/balance"))

    def ledger(self, *, after: int = 0, limit: int = 100) -> list[dict[str, Any]]:
        return list(self._json(self._http.get("/v1/ledger", params={"after": str(after), "limit": str(limit)})).get("entries", []))

    def usage(self, *, days: int = 30) -> dict[str, Any]:
        return self._json(self._http.get("/v1/usage", params={"days": str(days)}))

    def audit(self, *, limit: int = 50, before: int | None = None) -> dict[str, Any]:
        params = {"limit": str(limit)}
        if before is not None:
            params["before"] = str(before)
        return self._json(self._http.get("/v1/audit", params=params))

    def payments(self, *, limit: int = 50) -> list[dict[str, Any]]:
        return list(self._json(self._http.get("/v1/payments", params={"limit": str(limit)})).get("payments", []))

    def receipt(self, payment_id: str) -> str:
        resp = self._http.get(f"/v1/payments/{payment_id}/receipt")
        if resp.status_code >= 400:
            raise SubEthaError.from_response(resp)
        return resp.text

    def checkout(self, amount_usd: float, *, save_card: bool = False, success_url: str | None = None, cancel_url: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"amount_usd": amount_usd}
        if save_card:
            payload["save_card"] = True
        if success_url is not None:
            payload["success_url"] = success_url
        if cancel_url is not None:
            payload["cancel_url"] = cancel_url
        return self._json(self._http.post("/v1/billing/checkout", json=payload))

    def prices(self) -> dict[str, Any]:
        return self._json(self._http.get("/v1/prices"))

    def trace(self, topic: str, message_id: str) -> dict[str, Any]:
        return self._json(self._http.get(f"/v1/traces/{message_id}", params={"topic": topic}))

    def topics(self) -> list[dict[str, Any]]:
        return list(self._json(self._http.get("/v1/topics")).get("topics", []))

    def topic(self, topic: str) -> dict[str, Any]:
        return self._json(self._http.get(f"/v1/topics/{topic}"))

    def configure_topic(self, topic: str, policy: Mapping[str, Any]) -> dict[str, Any]:
        return self._json(self._http.put(f"/v1/topics/{topic}", json={"policy": dict(policy)}))

    def delete_topic(self, topic: str) -> dict[str, Any]:
        return self._json(self._http.delete(f"/v1/topics/{topic}"))

    def list_tokens(self) -> list[dict[str, Any]]:
        return list(self._json(self._http.get("/v1/tokens")).get("tokens", []))

    def create_token(self, **body: Any) -> dict[str, Any]:
        return self._json(self._http.post("/v1/tokens", json=body))

    def revoke_token(self, token_id: str) -> dict[str, Any]:
        return self._json(self._http.delete(f"/v1/tokens/{token_id}"))

    def list_devices(self) -> list[dict[str, Any]]:
        return list(self._json(self._http.get("/v1/devices")).get("devices", []))

    def update_device(self, device_id: str, **body: Any) -> dict[str, Any]:
        return self._json(self._http.patch(f"/v1/devices/{device_id}", json=body))

    def revoke_device(self, device_id: str) -> dict[str, Any]:
        return self._json(self._http.delete(f"/v1/devices/{device_id}"))

    def attach_device_key(self, name: str | None = None, capabilities: Sequence[str] = (), key: DeviceKey | None = None) -> dict[str, Any]:
        """As a devicebasedauth.org device (``dba=``), attaches an Ed25519 signing key (``key`` or
        ``device_key``): topic keys can then be sealed to it, and it can sign requests and messages.
        The DBA device needs grants for ``subetha:publish`` and ``subetha:subscribe`` on every topic."""
        k = key or self.device_key
        if k is None:
            raise ValueError("attach_device_key needs a device_key")
        body: dict[str, Any] = dict(enrollment_proof(k))
        if name is not None:
            body["name"] = name
        if capabilities:
            body["capabilities"] = list(capabilities)
        return self._json(self._http.post("/v1/devices/dba", json=body))

    def dba_link(self) -> dict[str, Any]:
        """The account's devicebasedauth.org link: ``linked``, ``dba_account``, ``issuer``, ``audience``."""
        return self._json(self._http.get("/v1/dba/link"))

    def start_dba_link(self) -> dict[str, Any]:
        """Starts linking (signed-in console sessions): open ``url``; devicebasedauth.org returns to /auth/dba/callback."""
        return self._json(self._http.post("/v1/dba/link/start", json={}))

    def finish_dba_link(self, code: str, state: str) -> dict[str, Any]:
        return self._json(self._http.post("/v1/dba/link/finish", json={"code": code, "state": state}))

    def unlink_dba(self) -> dict[str, Any]:
        return self._json(self._http.delete("/v1/dba/link"))

    def list_endpoints(self) -> list[dict[str, Any]]:
        return list(self._json(self._http.get("/v1/endpoints")).get("endpoints", []))

    def create_endpoint(self, kind: str, address: str, **extra: Any) -> dict[str, Any]:
        return self._json(self._http.post("/v1/endpoints", json={"kind": kind, "address": address, **extra}))

    def verify_endpoint(self, endpoint_id: str, code: str) -> dict[str, Any]:
        return self._json(self._http.post(f"/v1/endpoints/{endpoint_id}/verify", json={"code": code}))

    def update_endpoint(self, endpoint_id: str, **body: Any) -> dict[str, Any]:
        return self._json(self._http.patch(f"/v1/endpoints/{endpoint_id}", json=body))

    def test_endpoint(self, endpoint_id: str, **body: Any) -> dict[str, Any]:
        return self._json(self._http.post(f"/v1/endpoints/{endpoint_id}/test", json=body))

    def delete_endpoint(self, endpoint_id: str) -> dict[str, Any]:
        return self._json(self._http.delete(f"/v1/endpoints/{endpoint_id}"))

    def list_subscriptions(self) -> list[dict[str, Any]]:
        return list(self._json(self._http.get("/v1/subscriptions")).get("subscriptions", []))

    def create_subscription(self, topic: str, endpoint_id: str, **extra: Any) -> dict[str, Any]:
        return self._json(self._http.post("/v1/subscriptions", json={"topic": topic, "endpoint_id": endpoint_id, **extra}))

    def update_subscription(self, subscription_id: str, **body: Any) -> dict[str, Any]:
        return self._json(self._http.patch(f"/v1/subscriptions/{subscription_id}", json=body))

    def delete_subscription(self, subscription_id: str) -> dict[str, Any]:
        return self._json(self._http.delete(f"/v1/subscriptions/{subscription_id}"))

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
