"""HttpRelayPort over the SDK, with httpx.MockTransport."""

from __future__ import annotations

import json
import threading

import httpx

from subetha import Client
from subetha_reticulum.relay_http import HttpRelayPort

TOPIC = "@alice/doorbell"


def test_publish_sends_id_and_lxmf_from():
    seen = {}

    def handler(req):
        seen["req"] = req
        return httpx.Response(200, json=json.loads(req.content))

    port = HttpRelayPort("https://relay.test", "tk", client_factory=lambda: Client(
        "https://relay.test", token="tk", transport=httpx.MockTransport(handler)))
    port.start()
    out = port.publish(TOPIC, "Opened", title="Front door", id="01JD5A2Z3K8Q9V6X7W4T1R0S2M", extra={"lxmf_from": "a" * 32})
    body = json.loads(seen["req"].content)
    assert seen["req"].url.path == "/"
    assert body == {
        "topic": TOPIC, "message": "Opened", "title": "Front door",
        "id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "lxmf_from": "a" * 32,
    }
    assert out == body
    port.stop()


def test_subscribe_delivers_from_thread_and_resumes_since():
    m1 = {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "event": "message", "topic": TOPIC, "message": "one"}
    m2 = {"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2N", "event": "message", "topic": TOPIC, "message": "two"}
    calls = []
    got = []
    done = threading.Event()

    def handler(req):
        calls.append(dict(req.url.params))
        msgs = [m1] if len(calls) == 1 else [m2]
        return httpx.Response(200, content=("\n".join(json.dumps(m) for m in msgs) + "\n").encode())

    def factory():
        c = Client("https://relay.test", transport=httpx.MockTransport(handler))
        c.sleep = lambda s: None
        return c

    def on_msg(msg):
        got.append(msg["message"])
        if len(got) == 2:
            done.set()

    port = HttpRelayPort("https://relay.test", client_factory=factory, error_backoff=0.01)
    port.start()
    port.subscribe(TOPIC, on_msg, since="01JD5A2Z3K8Q9V6X7W4T1R0S29")
    assert done.wait(5)
    port.stop()
    assert got[:2] == ["one", "two"]
    assert calls[0]["since"] == "01JD5A2Z3K8Q9V6X7W4T1R0S29"
    assert calls[1]["since"] == m1["id"]
