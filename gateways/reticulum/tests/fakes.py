"""Fake ports for bridge tests."""

from __future__ import annotations

import hashlib
from typing import Any

from subetha_reticulum.ports import LxmfHandler, LxmfMessage, LxmfPort, RelayHandler, RelayPort


def dest_hash(topic: str) -> str:
    return hashlib.sha256(topic.encode()).hexdigest()[:32]


class FakeLxmf(LxmfPort):
    def __init__(self) -> None:
        self.handler: LxmfHandler | None = None
        self.topics: dict[str, str] = {}
        self.sent: list[dict[str, str]] = []
        self.announced = 0
        self.started = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.started = False

    def set_handler(self, handler: LxmfHandler) -> None:
        self.handler = handler

    def register_topic(self, topic: str, display_name: str) -> str:
        self.topics[topic] = display_name
        return dest_hash(topic)

    def send(self, from_topic: str, to: str, content: str, title: str = "") -> None:
        self.sent.append({"from_topic": from_topic, "to": to, "content": content, "title": title})

    def announce(self, topic: str | None = None) -> None:
        self.announced += 1

    # test helpers

    def receive(self, topic: str, source: str, content: str, title: str = "", message_id: str | None = None) -> None:
        assert self.handler is not None
        self.handler(LxmfMessage(dest_hash(topic), source, content, title, message_id))

    def to(self, address: str) -> list[dict[str, str]]:
        return [m for m in self.sent if m["to"] == address]


class FakeRelay(RelayPort):
    """Echoes every publish to subscribers synchronously, *before* publish returns, which is the
    worst case for echo suppression."""

    def __init__(self, echo: bool = True) -> None:
        self.echo = echo
        self.published: list[dict[str, Any]] = []
        self.acked: list[tuple[str, str, str]] = []
        self.handlers: dict[str, RelayHandler] = {}
        self.since: dict[str, str | None] = {}
        self.fail_with: Exception | None = None

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def publish(self, topic, message, *, title=None, id=None, extra=None):
        if self.fail_with is not None:
            raise self.fail_with
        env = {"id": id, "time": 1763750000, "event": "message", "topic": topic, "message": message}
        if title is not None:
            env["title"] = title
        env.update(extra or {})
        self.published.append(env)
        if self.echo:
            self.emit(dict(env))
        return env

    def subscribe(self, topic, handler, since=None):
        self.handlers[topic] = handler
        self.since[topic] = since

    def ack(self, topic, message_id, via="lxmf"):
        if self.fail_with is not None:
            raise self.fail_with
        self.acked.append((topic, message_id, via))

    def emit(self, msg: dict[str, Any]) -> None:
        self.handlers[msg["topic"]](msg)
