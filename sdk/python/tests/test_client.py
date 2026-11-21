"""Client tests against httpx.MockTransport."""

from __future__ import annotations

import json
import threading

import httpx
import pytest

from subetha import Client, SubEthaError
from subetha.protocol import device_key_from_seed, verify_envelope

TOPIC = "@alice/doorbell"
SEED = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")


def make_client(handler, token="tk_test"):
    return Client("https://relay.test", token=token, transport=httpx.MockTransport(handler))


def ndjson(*msgs):
    return ("\n".join(json.dumps(m) for m in msgs) + "\n").encode()


def test_publish_with_ntfy_headers():
    seen = {}

    def handler(req: httpx.Request):
        seen["req"] = req
        return httpx.Response(200, json={"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "topic": TOPIC, "message": "Opened"})

    c = make_client(handler)
    out = c.publish(
        TOPIC, "Opened", title="Front door", priority="high", tags=["door", "warning"],
        route={"mode": "cheap", "max_cost_usd_micros": 20000, "deny": ["sms", "voice"], "deadline_s": 60},
        dry_run=True, idempotency_key="abc",
    )
    req = seen["req"]
    assert out["id"] == "01JD5A2Z3K8Q9V6X7W4T1R0S2M"
    assert req.method == "POST"
    assert req.url.raw_path == b"/@alice/doorbell"
    assert req.content == b"Opened"
    h = req.headers
    assert h["authorization"] == "Bearer tk_test"
    assert h["x-title"] == "Front door"
    assert h["x-priority"] == "4"
    assert h["x-tags"] == "door,warning"
    assert h["x-route-mode"] == "cheap"
    assert h["x-max-cost"] == "0.02"
    assert h["x-deny"] == "sms,voice"
    assert h["x-deadline"] == "60"
    assert h["x-dry-run"] == "1"
    assert h["idempotency-key"] == "abc"


def test_publish_non_ascii_title_uses_json():
    seen = {}

    def handler(req):
        seen["req"] = req
        return httpx.Response(200, json=json.loads(req.content))

    c = make_client(handler, token=None)
    c.publish(TOPIC, "héllo 🚪", title="Tür", priority=3, tags=["ü"], extra={"lxmf_from": "ab" * 16})
    req = seen["req"]
    assert req.url.path == "/"
    assert "authorization" not in req.headers
    body = json.loads(req.content)
    assert body == {"topic": TOPIC, "message": "héllo 🚪", "title": "Tür", "tags": ["ü"], "lxmf_from": "ab" * 16}


def test_publish_signed():
    seen = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json=seen["body"])

    key = device_key_from_seed(SEED)
    c = make_client(handler)
    out = c.publish(TOPIC, "Opened", title="Front door", sign_with=key)
    body = seen["body"]
    assert seen["body"] == out
    assert body["sender"] == key.device_id
    assert isinstance(body["id"], str) and len(body["id"]) == 26
    assert isinstance(body["time"], int)
    assert verify_envelope(body)


def test_publish_rejects_bad_topic():
    c = make_client(lambda req: httpx.Response(200))
    with pytest.raises(ValueError):
        c.publish("doorbell", "x")


def test_error_body_raises_subetha_error():
    body = {"error": "insufficient_balance", "http": 402, "message": "top up", "shortfall_usd_micros": 1234}

    c = make_client(lambda req: httpx.Response(402, json=body))
    with pytest.raises(SubEthaError) as ei:
        c.publish(TOPIC, "x")
    e = ei.value
    assert (e.code, e.http, e.message) == ("insufficient_balance", 402, "top up")
    assert e.body["shortfall_usd_micros"] == 1234


def test_non_json_error_falls_back_to_status_code():
    c = make_client(lambda req: httpx.Response(429, text="slow down", headers={"Retry-After": "7"}))
    with pytest.raises(SubEthaError) as ei:
        c.poll(TOPIC)
    assert ei.value.code == "rate_limited"
    assert ei.value.retry_after == 7.0


def test_poll():
    seen = {}

    def handler(req):
        seen["req"] = req
        return httpx.Response(
            200,
            content=ndjson(
                {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "event": "message", "topic": TOPIC, "message": "a"},
                {"id": "x", "event": "keepalive", "topic": TOPIC},
                {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2N", "topic": TOPIC, "message": "b"},
            ),
        )

    c = make_client(handler)
    msgs = c.poll(TOPIC, since="all")
    assert [m["message"] for m in msgs] == ["a", "b"]
    assert seen["req"].url.raw_path == b"/@alice/doorbell/json?poll=1&since=all"


def test_poll_multiple_topics():
    seen = {}

    def handler(req):
        seen["path"] = req.url.raw_path
        return httpx.Response(200, content=b"")

    t2 = "t_mfrggzdfmztwq2lknnwg23tpoa"
    assert make_client(handler).poll([TOPIC, t2]) == []
    assert seen["path"] == b"/@alice/doorbell,t_mfrggzdfmztwq2lknnwg23tpoa/json?poll=1"


def test_subscribe_dedupes_and_reconnects_with_since():
    m1 = {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "event": "message", "topic": TOPIC, "message": "one"}
    m2 = {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2N", "event": "message", "topic": TOPIC, "message": "two"}
    m3 = {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2P", "event": "message", "topic": TOPIC, "message": "three"}
    requests = []

    def handler(req):
        requests.append(req)
        if len(requests) == 1:
            return httpx.Response(200, content=ndjson({"event": "open", "id": "o1"}, m1, m2, m1))
        if len(requests) == 2:
            raise httpx.ConnectError("boom", request=req)
        # The server repeats m2 (since is inclusive on some servers); it must be deduped.
        return httpx.Response(200, content=ndjson(m2, {"event": "keepalive", "id": "k"}, m3))

    c = make_client(handler)
    c.sleep = lambda s: None
    got = list(c.subscribe(TOPIC, max_reconnects=2))
    assert [m["message"] for m in got] == ["one", "two", "three"]
    assert "since" not in requests[0].url.params
    assert requests[1].url.params["since"] == m2["id"]
    assert requests[2].url.params["since"] == m2["id"]


def test_subscribe_raises_client_errors():
    c = make_client(lambda req: httpx.Response(403, json={"error": "forbidden", "http": 403, "message": "no"}))
    with pytest.raises(SubEthaError) as ei:
        next(c.subscribe(TOPIC))
    assert ei.value.code == "forbidden"


def test_subscribe_stop_event():
    stop = threading.Event()
    m1 = {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "event": "message", "topic": TOPIC, "message": "one"}
    c = make_client(lambda req: httpx.Response(200, content=ndjson(m1)))
    gen = c.subscribe(TOPIC, stop=stop)
    assert next(gen)["message"] == "one"
    stop.set()
    assert list(gen) == []
