"""Core LXMF <-> SubEtha bridge logic. Pure: all I/O goes through the two ports."""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from functools import partial
from typing import Any

from subetha import SubEthaError
from subetha.protocol import Deduper, ulid

from .ports import LxmfMessage, LxmfPort, RelayPort
from .store import SubscriberStore

log = logging.getLogger(__name__)

#: Extension field carrying the LXMF address of the peer a message came from (spec §2: relays
#: preserve unknown fields). Used for echo suppression across restarts and across gateways.
LXMF_FROM = "lxmf_from"

HELP = """SubEtha gateway for {topic}

Send any text to publish it to the topic.
/subscribe    receive the topic's messages here
/unsubscribe  stop receiving them
/status       show whether you are subscribed
/help         this text

Start a message with // to publish text that begins with /."""


@dataclass(frozen=True)
class TopicMapping:
    topic: str
    #: Display name announced with the LXMF destination.
    name: str | None = None
    #: Allow LXMF -> relay publishing.
    publish: bool = True
    #: Allow relay -> LXMF delivery (and therefore /subscribe).
    deliver: bool = True
    #: LXMF addresses (lowercase hex) allowed to use this destination. Empty = anyone.
    allow: frozenset[str] = field(default_factory=frozenset)

    @property
    def display_name(self) -> str:
        return self.name or f"SubEtha {self.topic}"

    def allows(self, address: str) -> bool:
        return not self.allow or address in self.allow


class Bridge:
    """Bridges LXMF destinations to SubEtha topics.

    - An LXMF message to a topic's destination is published to the relay with the sender's
      address in ``lxmf_from`` (commands ``/subscribe``, ``/unsubscribe``, ``/status``,
      ``/help`` are handled locally instead).
    - A relay message on a mapped topic is sent to every LXMF subscriber of the topic except
      the peer it came from.
    - Relay messages are deduped by id and inbound LXMF messages by LXMF message hash.
    """

    def __init__(
        self,
        lxmf: LxmfPort,
        relay: RelayPort,
        mappings: list[TopicMapping],
        store: SubscriberStore | None = None,
        *,
        dedupe_capacity: int = 10_000,
    ) -> None:
        topics = [m.topic for m in mappings]
        if len(set(topics)) != len(topics):
            raise ValueError("duplicate topic mapping")
        self.lxmf = lxmf
        self.relay = relay
        self.mappings = {m.topic: m for m in mappings}
        self.store = store if store is not None else SubscriberStore()
        self._by_dest: dict[str, TopicMapping] = {}
        self._dest_of: dict[str, str] = {}
        self._relay_seen = Deduper(dedupe_capacity)
        self._lxmf_seen = Deduper(dedupe_capacity)
        self._origins: OrderedDict[str, str] = OrderedDict()  # message id -> LXMF source
        self._origins_cap = dedupe_capacity
        self._lock = threading.Lock()
        self._started = False

    # ---- lifecycle ----

    def start(self) -> None:
        if self._started:
            return
        self.lxmf.start()
        self.relay.start()
        self.lxmf.set_handler(self.on_lxmf)
        for m in self.mappings.values():
            dest = self.lxmf.register_topic(m.topic, m.display_name).lower()
            self._by_dest[dest] = m
            self._dest_of[m.topic] = dest
            log.info("topic %s <-> LXMF %s", m.topic, dest)
        for m in self.mappings.values():
            if m.deliver:
                self.relay.subscribe(m.topic, partial(self.on_relay, m.topic), since=self.store.cursor(m.topic))
        self._started = True
        self.announce()

    def stop(self) -> None:
        self.relay.stop()
        self.lxmf.stop()
        self._started = False

    def announce(self) -> None:
        self.lxmf.announce()

    def destinations(self) -> dict[str, str]:
        """topic -> LXMF destination hash (hex)."""
        return dict(self._dest_of)

    # ---- LXMF -> relay ----

    def on_lxmf(self, msg: LxmfMessage) -> None:
        if msg.message_id and not self._lxmf_seen.accept({"id": msg.message_id}):
            log.debug("duplicate LXMF message %s", msg.message_id)
            return
        mapping = self._by_dest.get(msg.destination.lower())
        if mapping is None:
            log.warning("LXMF message for unknown destination %s", msg.destination)
            return
        source = msg.source.lower()
        if not mapping.allows(source):
            log.info("rejected LXMF %s on %s: not in allow list", source, mapping.topic)
            self._reply(mapping, source, "You are not allowed to use this gateway destination.")
            return
        if mapping.allow and not msg.verified:
            # The source address is only a claim until its identity is known; don't let an
            # allow list be bypassed by spoofing it.
            log.info("unverified LXMF %s on allow-listed %s", source, mapping.topic)
            self._reply(mapping, source, "Could not verify your LXMF identity yet. Announce, wait a moment, and resend.")
            return

        text = msg.content.strip()
        if text.startswith("/") and not text.startswith("//"):
            self._command(mapping, source, text)
            return
        if text.startswith("//"):
            text = text[1:]
        if not mapping.publish:
            self._reply(mapping, source, f"{mapping.topic} is receive-only here. Send /help for commands.")
            return
        title = msg.title.strip() or None
        if not text and not title:
            return

        id_ = ulid()
        self._remember_origin(id_, source)  # before publishing: the echo can beat the response
        try:
            self.relay.publish(mapping.topic, text, title=title, id=id_, extra={LXMF_FROM: source})
        except SubEthaError as e:
            self._forget_origin(id_)
            log.warning("publish to %s failed: %s", mapping.topic, e)
            self._reply(mapping, source, f"Publish failed: {e.code}" + (f": {e.message}" if e.message else ""))
        except Exception as e:  # noqa: BLE001 - report any relay failure back to the sender
            self._forget_origin(id_)
            log.exception("publish to %s failed", mapping.topic)
            self._reply(mapping, source, f"Publish failed: {e.__class__.__name__}")

    def _command(self, mapping: TopicMapping, source: str, text: str) -> None:
        cmd = text.split()[0].lower()
        topic = mapping.topic
        if cmd == "/subscribe":
            if not mapping.deliver:
                reply = f"{topic} does not deliver messages over LXMF."
            elif self.store.add(topic, source):
                reply = f"Subscribed to {topic}. Send /unsubscribe to stop."
            else:
                reply = f"You are already subscribed to {topic}."
        elif cmd == "/unsubscribe":
            if self.store.remove(topic, source):
                reply = f"Unsubscribed from {topic}."
            else:
                reply = f"You were not subscribed to {topic}."
        elif cmd == "/status":
            state = "subscribed" if self.store.is_subscribed(topic, source) else "not subscribed"
            reply = f"You are {state} to {topic}."
        elif cmd in ("/help", "/start"):
            reply = HELP.format(topic=topic)
        else:
            reply = f"Unknown command {cmd}.\n\n" + HELP.format(topic=topic)
        self._reply(mapping, source, reply)

    def _reply(self, mapping: TopicMapping, to: str, text: str) -> None:
        try:
            self.lxmf.send(mapping.topic, to, text, title=mapping.display_name)
        except Exception:  # noqa: BLE001
            log.exception("LXMF reply to %s failed", to)

    def _remember_origin(self, id_: str, source: str) -> None:
        with self._lock:
            self._origins[id_.upper()] = source
            while len(self._origins) > self._origins_cap:
                self._origins.popitem(last=False)

    def _forget_origin(self, id_: str) -> None:
        with self._lock:
            self._origins.pop(id_.upper(), None)

    # ---- relay -> LXMF ----

    def on_relay(self, topic: str, msg: dict[str, Any]) -> None:
        if msg.get("event", "message") != "message":
            return
        if not self._relay_seen.accept(msg):
            log.debug("duplicate relay message %s", msg.get("id"))
            return
        id_ = msg.get("id")
        # Comma-subscriptions aside, the relay tells us the topic; fall back to the mapping's.
        topic = msg.get("topic") if msg.get("topic") in self.mappings else topic
        mapping = self.mappings.get(topic)
        if mapping is None:
            return
        if isinstance(id_, str):
            self.store.set_cursor(topic, id_)
        if not mapping.deliver:
            return
        origin = None
        if isinstance(id_, str):
            with self._lock:
                origin = self._origins.pop(id_.upper(), None)
        if origin is None and isinstance(msg.get(LXMF_FROM), str):
            origin = msg[LXMF_FROM].lower()
        title, content = format_for_lxmf(msg)
        for sub in self.store.subscribers(topic):
            if sub == origin:
                continue  # echo suppression: never send a peer its own message back
            try:
                self.lxmf.send(topic, sub, content, title=title)
            except Exception:  # noqa: BLE001 - one bad peer must not block the others
                log.exception("LXMF delivery of %s to %s failed", id_, sub)


    def deliver_direct(self, destination: str, msg: dict[str, Any], default_topic: str | None = None) -> None:
        """Relay-pushed delivery to one LXMF address (endpoint subscriptions). Sent from the
        destination of the message's topic if it is mapped here, else from `default_topic`."""
        topic = msg.get("topic") if msg.get("topic") in self.mappings else default_topic or next(iter(self.mappings), None)
        if topic is None:
            raise RuntimeError("no topic destination to send from")
        key = {"id": f"{msg.get('id')}:{destination}"} if msg.get("id") else {}
        if key and not self._relay_seen.accept(key):
            return
        title, content = format_for_lxmf(msg)
        self.lxmf.send(topic, destination, content, title=title)


def format_for_lxmf(msg: dict[str, Any]) -> tuple[str, str]:
    """Builds (title, content) for an LXMF message from a relay envelope."""
    title = msg.get("title") if isinstance(msg.get("title"), str) else None
    if msg.get("enc"):
        body = "[end-to-end encrypted message; open it in a SubEtha client that holds the topic key]"
        title = None  # the real title is encrypted too
    else:
        body = msg.get("message") if isinstance(msg.get("message"), str) else ""
    extras = []
    if isinstance(msg.get("click"), str):
        extras.append(msg["click"])
    att = msg.get("attachment")
    if isinstance(att, dict) and isinstance(att.get("url"), str):
        name = att.get("name") if isinstance(att.get("name"), str) else "attachment"
        extras.append(f"{name}: {att['url']}")
    if extras:
        body = "\n\n".join([body, *extras]) if body else "\n".join(extras)
    return title or str(msg.get("topic", "SubEtha")), body
