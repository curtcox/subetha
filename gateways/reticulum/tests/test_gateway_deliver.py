import hashlib
import hmac
import http.client
import json
import time

from subetha_reticulum import Bridge, TopicMapping
from subetha_reticulum.health import serve_health, verify_signature

from fakes import FakeLxmf, FakeRelay

PEER = "ab" * 16


def sign(secret: str, body: bytes, t: int | None = None) -> str:
    t = int(time.time()) if t is None else t
    return f"t={t},v1=" + hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()


def test_verify_signature():
    body = b'{"x":1}'
    assert verify_signature("s", body, sign("s", body))
    assert not verify_signature("s", body, sign("other", body))
    assert not verify_signature("s", body, sign("s", body, t=1))
    assert not verify_signature("s", body, None)


def test_deliver_direct_dedupes_and_uses_topic_destination():
    lxmf, relay = FakeLxmf(), FakeRelay()
    bridge = Bridge(lxmf, relay, [TopicMapping(topic="@a/x"), TopicMapping(topic="@a/y")])
    msg = {"id": "01JD0000000000000000000001", "topic": "@a/y", "title": "T", "message": "hello"}
    bridge.deliver_direct(PEER, msg)
    bridge.deliver_direct(PEER, msg)
    assert len(lxmf.sent) == 1
    assert lxmf.sent[0]["from_topic"] == "@a/y"
    bridge.deliver_direct(PEER, {**msg, "id": "01JD0000000000000000000002", "topic": "@other/z"})
    assert lxmf.sent[1]["from_topic"] == "@a/x"


def test_http_deliver_endpoint():
    lxmf, relay = FakeLxmf(), FakeRelay()
    bridge = Bridge(lxmf, relay, [TopicMapping(topic="@a/x")])
    server = serve_health(0, lambda: {"ok": True}, host="127.0.0.1", deliver=bridge.deliver_direct, deliver_secret="sec")
    port = server.server_address[1]
    try:
        def post(body: bytes, sig: str | None):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            headers = {"Content-Type": "application/json", "Content-Length": str(len(body))}
            if sig:
                headers["X-SubEtha-Signature"] = sig
            c.request("POST", "/deliver", body=body, headers=headers)
            return c.getresponse().status

        body = json.dumps({"destination": PEER, "message": {"id": "01JD0000000000000000000003", "topic": "@a/x", "message": "hi"}}).encode()
        assert post(body, None) == 401
        assert post(body, sign("wrong", body)) == 401
        assert post(body, sign("sec", body)) == 204
        assert lxmf.sent[0]["to"] == PEER
        bad = json.dumps({"destination": "nothex", "message": {}}).encode()
        assert post(bad, sign("sec", bad)) == 400
        # Malformed Content-Length returns 400 rather than crashing the request handler.
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.putrequest("POST", "/deliver")
        c.putheader("Content-Length", "not-a-number")
        c.endheaders()
        assert c.getresponse().status == 400
    finally:
        server.shutdown()
