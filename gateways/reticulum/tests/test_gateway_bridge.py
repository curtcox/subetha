from __future__ import annotations

import pytest
from fakes import FakeLxmf, FakeRelay, dest_hash

from subetha import SubEthaError
from subetha.protocol import is_ulid
from subetha_reticulum import Bridge, SubscriberStore, TopicMapping, format_for_lxmf

TOPIC = "@alice/doorbell"
ALICE = "a" * 32
BOB = "b" * 32
CAROL = "c" * 32


def make(mappings=None, store=None, echo=True):
    lxmf, relay = FakeLxmf(), FakeRelay(echo=echo)
    bridge = Bridge(lxmf, relay, mappings or [TopicMapping(TOPIC, name="Doorbell")], store)
    bridge.start()
    return bridge, lxmf, relay


def relay_msg(id_, message="hi", **kw):
    return {"id": id_, "time": 1763750000, "event": "message", "topic": TOPIC, "message": message, **kw}


def test_start_registers_announces_and_subscribes():
    bridge, lxmf, relay = make()
    assert lxmf.topics == {TOPIC: "Doorbell"}
    assert bridge.destinations() == {TOPIC: dest_hash(TOPIC)}
    assert lxmf.announced == 1
    assert TOPIC in relay.handlers and relay.since[TOPIC] is None


def test_inbound_lxmf_publishes_to_relay():
    _, lxmf, relay = make(echo=False)
    lxmf.receive(TOPIC, ALICE.upper(), "  Opened  ", title="Front door")
    assert len(relay.published) == 1
    p = relay.published[0]
    assert p["topic"] == TOPIC
    assert p["message"] == "Opened"
    assert p["title"] == "Front door"
    assert p["lxmf_from"] == ALICE
    assert is_ulid(p["id"])
    assert lxmf.sent == []


def test_double_slash_escapes_commands_and_empty_is_ignored():
    _, lxmf, relay = make(echo=False)
    lxmf.receive(TOPIC, ALICE, "//subscribe is a word")
    lxmf.receive(TOPIC, ALICE, "   ")
    assert [p["message"] for p in relay.published] == ["/subscribe is a word"]


def test_outbound_fan_out_to_subscribers():
    _, lxmf, relay = make()
    lxmf.receive(TOPIC, ALICE, "/subscribe")
    lxmf.receive(TOPIC, BOB, "/subscribe")
    lxmf.sent.clear()
    relay.emit(relay_msg("01JD5A2Z3K8Q9V6X7W4T1R0S2M", "Opened", title="Front door"))
    assert sorted(m["to"] for m in lxmf.sent) == [ALICE, BOB]
    for m in lxmf.sent:
        assert m == {"from_topic": TOPIC, "to": m["to"], "content": "Opened", "title": "Front door"}
    assert lxmf.to(CAROL) == []


def test_subscribe_unsubscribe_status_help_commands(tmp_path):
    store = SubscriberStore(tmp_path / "state.json")
    bridge, lxmf, relay = make(store=store)
    lxmf.receive(TOPIC, ALICE, "/subscribe")
    assert store.subscribers(TOPIC) == [ALICE]
    assert "Subscribed to @alice/doorbell" in lxmf.sent[-1]["content"]
    assert lxmf.sent[-1]["title"] == "Doorbell"

    lxmf.receive(TOPIC, ALICE, "/SUBSCRIBE")
    assert "already subscribed" in lxmf.sent[-1]["content"]

    lxmf.receive(TOPIC, ALICE, "/status")
    assert "You are subscribed" in lxmf.sent[-1]["content"]

    # Persisted.
    assert SubscriberStore(tmp_path / "state.json").subscribers(TOPIC) == [ALICE]

    lxmf.receive(TOPIC, ALICE, "/unsubscribe")
    assert store.subscribers(TOPIC) == []
    assert "Unsubscribed" in lxmf.sent[-1]["content"]
    lxmf.receive(TOPIC, ALICE, "/unsubscribe")
    assert "not subscribed" in lxmf.sent[-1]["content"]

    lxmf.receive(TOPIC, ALICE, "/help")
    assert "/subscribe" in lxmf.sent[-1]["content"] and TOPIC in lxmf.sent[-1]["content"]
    lxmf.receive(TOPIC, ALICE, "/frobnicate")
    assert lxmf.sent[-1]["content"].startswith("Unknown command /frobnicate")

    assert relay.published == []  # commands are never published
    assert all(m["to"] == ALICE for m in lxmf.sent)


def test_echo_suppressed_for_originating_peer():
    _, lxmf, relay = make(echo=True)  # relay echoes before publish() returns
    for who in (ALICE, BOB):
        lxmf.receive(TOPIC, who, "/subscribe")
    lxmf.sent.clear()
    lxmf.receive(TOPIC, ALICE, "Opened")
    assert len(relay.published) == 1
    assert lxmf.to(ALICE) == []
    assert [m["content"] for m in lxmf.to(BOB)] == ["Opened"]


def test_echo_suppressed_by_lxmf_from_field():
    # E.g. after a gateway restart, or a message bridged by another gateway.
    _, lxmf, relay = make()
    for who in (ALICE, BOB):
        lxmf.receive(TOPIC, who, "/subscribe")
    lxmf.sent.clear()
    relay.emit(relay_msg("01JD5A2Z3K8Q9V6X7W4T1R0S2M", lxmf_from=ALICE.upper()))
    assert lxmf.to(ALICE) == []
    assert len(lxmf.to(BOB)) == 1


def test_relay_messages_deduped_by_id():
    _, lxmf, relay = make()
    lxmf.receive(TOPIC, ALICE, "/subscribe")
    lxmf.sent.clear()
    relay.emit(relay_msg("01JD5A2Z3K8Q9V6X7W4T1R0S2M"))
    relay.emit(relay_msg("01jd5a2z3k8q9v6x7w4t1r0s2m"))
    relay.emit(relay_msg("01JD5A2Z3K8Q9V6X7W4T1R0S2N"))
    relay.emit({"id": "k1", "event": "keepalive", "topic": TOPIC})
    assert len(lxmf.sent) == 2


def test_lxmf_messages_deduped_by_hash():
    _, lxmf, relay = make(echo=False)
    lxmf.receive(TOPIC, ALICE, "Opened", message_id="ff" * 32)
    lxmf.receive(TOPIC, ALICE, "Opened", message_id="ff" * 32)
    lxmf.receive(TOPIC, ALICE, "Opened", message_id="ee" * 32)
    assert len(relay.published) == 2


def test_cursor_persisted_and_used_on_restart(tmp_path):
    store = SubscriberStore(tmp_path / "state.json")
    _, _, relay = make(store=store)
    relay.emit(relay_msg("01JD5A2Z3K8Q9V6X7W4T1R0S2M"))
    _, _, relay2 = make(store=SubscriberStore(tmp_path / "state.json"))
    assert relay2.since[TOPIC] == "01JD5A2Z3K8Q9V6X7W4T1R0S2M"


def test_publish_failure_is_reported_to_sender():
    _, lxmf, relay = make()
    relay.fail_with = SubEthaError("insufficient_balance", 402, "top up")
    lxmf.receive(TOPIC, ALICE, "Opened")
    assert lxmf.sent[-1]["to"] == ALICE
    assert lxmf.sent[-1]["content"] == "Publish failed: insufficient_balance: top up"


def test_allow_list():
    _, lxmf, relay = make([TopicMapping(TOPIC, allow=frozenset({ALICE}))], echo=False)
    lxmf.receive(TOPIC, BOB, "Opened")
    lxmf.receive(TOPIC, BOB, "/subscribe")
    assert relay.published == []
    assert all("not allowed" in m["content"] for m in lxmf.to(BOB))
    lxmf.receive(TOPIC, ALICE, "Opened")
    assert len(relay.published) == 1


def test_receive_only_and_publish_only_mappings():
    other = "t_mfrggzdfmztwq2lknnwg23tpoa"
    _, lxmf, relay = make([TopicMapping(TOPIC, publish=False), TopicMapping(other, deliver=False)], echo=False)
    assert set(relay.handlers) == {TOPIC}  # publish-only topics aren't subscribed
    lxmf.receive(TOPIC, ALICE, "hello")
    assert relay.published == [] and "receive-only" in lxmf.sent[-1]["content"]
    lxmf.receive(other, ALICE, "/subscribe")
    assert "does not deliver" in lxmf.sent[-1]["content"]
    lxmf.receive(other, ALICE, "hello")
    assert relay.published[-1]["topic"] == other


def test_unknown_destination_ignored():
    _, lxmf, relay = make()
    from subetha_reticulum.ports import LxmfMessage

    lxmf.handler(LxmfMessage("0" * 32, ALICE, "hello"))
    assert relay.published == [] and lxmf.sent == []


def test_duplicate_mappings_rejected():
    with pytest.raises(ValueError):
        Bridge(FakeLxmf(), FakeRelay(), [TopicMapping(TOPIC), TopicMapping(TOPIC)])


def test_one_failing_peer_does_not_block_others():
    _, lxmf, relay = make()
    for who in (ALICE, BOB):
        lxmf.receive(TOPIC, who, "/subscribe")
    lxmf.sent.clear()
    real_send = lxmf.send

    def flaky(from_topic, to, content, title=""):
        if to == ALICE:
            raise RuntimeError("no path")
        real_send(from_topic, to, content, title)

    lxmf.send = flaky
    relay.emit(relay_msg("01JD5A2Z3K8Q9V6X7W4T1R0S2M"))
    assert [m["to"] for m in lxmf.sent] == [BOB]


def test_format_for_lxmf():
    assert format_for_lxmf({"topic": TOPIC, "message": "m"}) == (TOPIC, "m")
    title, body = format_for_lxmf(
        {"topic": TOPIC, "title": "T", "message": "m", "click": "https://x", "attachment": {"name": "a.jpg", "url": "https://f"}}
    )
    assert title == "T" and body == "m\n\nhttps://x\n\na.jpg: https://f"
    title, body = format_for_lxmf({"topic": TOPIC, "message": "Ps5p", "enc": {"alg": "xchacha20poly1305"}})
    assert title == TOPIC and "encrypted" in body


def test_unverified_sender_rejected_on_allow_listed_topic():
    from subetha_reticulum.ports import LxmfMessage

    _, lxmf, relay = make([TopicMapping(TOPIC, allow=frozenset({ALICE}))], echo=False)
    lxmf.handler(LxmfMessage(dest_hash(TOPIC), ALICE, "spoofed?", verified=False))
    assert relay.published == []
    assert "verify" in lxmf.sent[-1]["content"]
    # Open topics accept unverified senders (the address is recorded as claimed).
    _, lxmf2, relay2 = make(echo=False)
    lxmf2.handler(LxmfMessage(dest_hash(TOPIC), BOB, "hi", verified=False))
    assert relay2.published[0]["lxmf_from"] == BOB
