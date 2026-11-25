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


def test_device_signed_requests_replace_the_bearer_token():
    from subetha.protocol import base64url_decode, request_signing_input

    seen = {}

    def handler(req: httpx.Request):
        seen["req"] = req
        return httpx.Response(200, json={"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "topic": TOPIC, "message": "Opened"})

    key = device_key_from_seed(SEED)
    c = Client("https://relay.test", token="tk_test", device_key=key, sign_requests=True, transport=httpx.MockTransport(handler))
    c.publish(TOPIC, "Opened", title="Front door", priority="high", idempotency_key="abc")
    req = seen["req"]
    assert "authorization" not in req.headers
    assert req.headers["x-device-id"] == key.device_id
    listed = req.headers["x-device-signed-headers"].split(",")
    assert listed[:3] == ["x-device-id", "x-device-time", "x-device-nonce"]
    assert {"content-type", "idempotency-key", "x-priority", "x-title"} <= set(listed)
    # Verify the way the relay does: each listed header with its value as received.
    data = request_signing_input(req.method, str(req.url), req.content, [(n, req.headers[n]) for n in listed]).encode()
    key.private_key.public_key().verify(base64url_decode(req.headers["x-device-signature"]), data)
    with pytest.raises(ValueError):
        Client(sign_requests=True)


def test_share_and_load_topic_keys():
    import json as _json

    from subetha.protocol import device_key_from_seed

    dev = device_key_from_seed(bytes([7]) * 32)
    store: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "PUT" and req.url.path == "/v1/keys":
            keys = _json.loads(req.content)["keys"]
            store.extend(dict(k, created_at=len(store) + 1) for k in keys)
            return httpx.Response(200, json={"stored": len(keys)})
        if req.method == "GET" and req.url.path == "/v1/keys":
            return httpx.Response(200, json={"keys": store})
        return httpx.Response(404, json={"error": "not_found"})

    c = Client("https://relay.test", token="tk", device_key=dev, transport=httpx.MockTransport(handler))
    assert c.share_topic_key("@a/vault", "k1", bytes([1]) * 32, [dev.device_id]) == 1
    assert c.share_topic_key("@a/vault", "k2", bytes([2]) * 32, [dev.device_id]) == 1
    assert c.load_topic_keys() == {"@a/vault": ("k2", bytes([2]) * 32)}
    other = device_key_from_seed(bytes([8]) * 32)
    assert c.load_topic_keys(device_key=other) == {}


def test_auto_e2ee_ack_file_and_control_plane():
    stored: list[dict] = []
    acks: list[dict] = []
    files: list[tuple[bytes, dict]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "POST" and req.url.path == "/":
            env = json.loads(req.content)
            stored.append(env)
            return httpx.Response(200, json=env)
        if req.method == "GET" and req.url.path == "/@alice/doorbell/json":
            return httpx.Response(200, content=ndjson(*stored))
        if req.method == "POST" and req.url.path == "/v1/ack":
            acks.append(json.loads(req.content))
            return httpx.Response(200, json={"acked": True})
        if req.method == "PUT" and req.url.path == "/@alice/doorbell":
            files.append((req.content, dict(req.headers)))
            return httpx.Response(200, json={"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2F", "topic": TOPIC, "message": "snap"})
        if req.method == "GET" and req.url.path == "/v1/balance":
            return httpx.Response(200, json={"available_usd_micros": 5_000_000, "reserved_usd_micros": 0})
        if req.method == "DELETE" and req.url.path == "/v1/keys":
            return httpx.Response(200, json={"deleted": 1})
        return httpx.Response(404, json={"error": "not_found"})

    key = bytes([42]) * 32
    dev = device_key_from_seed(SEED)
    c = Client("https://relay.test", token="tk", topic_keys={TOPIC: ("k42", key)}, transport=httpx.MockTransport(handler))
    enc = c.publish(TOPIC, "secret code 4721", title="Vault", sign_with=dev)
    assert enc["enc"]["kid"] == "k42"
    assert enc["message"] != "secret code 4721"

    # poll auto-decrypts and verifies signature
    msgs = c.poll(TOPIC, verify=True, require_signature=True, priority=[3], tags=["a"])
    assert len(msgs) == 1
    assert msgs[0]["message"] == "secret code 4721"
    assert msgs[0]["title"] == "Vault"

    # subscribe auto_ack sends POST /v1/ack
    sub_msgs = list(c.subscribe(TOPIC, reconnect=False, auto_ack=True, verify=True))
    assert len(sub_msgs) == 1 and sub_msgs[0]["message"] == "secret code 4721"
    assert acks == [{"topic": TOPIC, "id": enc["id"], "via": "stream"}]

    # publish_file + control plane
    c.publish_file(TOPIC, "snap.jpg", b"\xff\xd8\xff", content_type="image/jpeg", message="front door")
    assert files[0][0] == b"\xff\xd8\xff"
    assert files[0][1]["x-filename"] == "snap.jpg"
    assert c.balance()["available_usd_micros"] == 5_000_000
    assert c.delete_wrapped_keys(TOPIC, kid="k42") == 1


def test_dba_device_attaches_a_signing_key_and_manages_the_link():
    from subetha import device_key_from_seed
    from subetha.protocol import base64url_decode
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    key = device_key_from_seed(bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path == "/v1/devices/dba":
            return httpx.Response(201, json={"id": key.device_id, "enrolled": True, "dba_device": "dba:d1"})
        if req.method == "GET":
            return httpx.Response(200, json={"linked": True, "dba_account": "a1", "issuer": "https://devicebasedauth.org", "audience": "subetha.us"})
        return httpx.Response(200, json={"linked": False})

    class FakeDba:
        def headers(self, method: str, url: str) -> dict[str, str]:
            return {"Authorization": "DBA cred", "DPoP": f"proof:{method}:{url}"}

    c = Client("https://relay.test", token="tk_ignored", device_key=key, dba=FakeDba(), transport=httpx.MockTransport(handler))
    assert c.attach_device_key(name="pi", capabilities=["ws"])["dba_device"] == "dba:d1"
    r = seen[0]
    assert r.headers["authorization"] == "DBA cred"
    assert r.headers["dpop"] == "proof:POST:https://relay.test/v1/devices/dba"
    body = json.loads(r.content)
    assert body["device_id"] == key.device_id and body["name"] == "pi" and body["capabilities"] == ["ws"]
    Ed25519PublicKey.from_public_bytes(key.public_key).verify(
        base64url_decode(body["proof"]), f"subetha-enroll-v1\n{key.device_id}\n{body['time']}".encode()
    )
    assert c.dba_link()["dba_account"] == "a1"
    c.unlink_dba()
    assert seen[-1].method == "DELETE" and seen[-1].url.path == "/v1/dba/link"
    # A callable works too, and dba can't be combined with sign_requests.
    c2 = Client("https://relay.test", dba=lambda m, u: {"Authorization": "DBA x", "DPoP": "p"}, transport=httpx.MockTransport(handler))
    c2.dba_link()
    assert seen[-1].headers["authorization"] == "DBA x"
    with pytest.raises(ValueError):
        Client(device_key=key, sign_requests=True, dba=FakeDba())
