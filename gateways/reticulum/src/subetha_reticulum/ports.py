"""The two ports the bridge talks to. Real adapters: ``RnsLxmfPort`` and ``HttpRelayPort``."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True)
class LxmfMessage:
    """An inbound LXMF message, reduced to what the bridge needs. Hashes are lowercase hex."""

    destination: str  #: the gateway's topic destination it was sent to
    source: str  #: the sender's LXMF delivery destination
    content: str
    title: str = ""
    message_id: str | None = None  #: LXMF message hash, used for dedupe
    fields: dict[Any, Any] = field(default_factory=dict)
    #: False when the sender's signature couldn't be checked because its identity isn't known
    #: yet (it hasn't announced, or the announce hasn't reached us). ``source`` is then a claim.
    verified: bool = True


LxmfHandler = Callable[[LxmfMessage], None]
RelayHandler = Callable[[dict[str, Any]], None]


class LxmfPort(ABC):
    """The Reticulum/LXMF side."""

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...

    @abstractmethod
    def set_handler(self, handler: LxmfHandler) -> None:
        """Registers the callback for inbound messages to any topic destination."""

    @abstractmethod
    def register_topic(self, topic: str, display_name: str) -> str:
        """Creates (or loads) the topic's LXMF destination and returns its hash as hex."""

    @abstractmethod
    def send(self, from_topic: str, to: str, content: str, title: str = "") -> None:
        """Sends an LXMF message from a topic's destination to an LXMF address (hex)."""

    @abstractmethod
    def announce(self, topic: str | None = None) -> None:
        """Announces one topic's destination, or all of them."""


class RelayPort(ABC):
    """The SubEtha relay side."""

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...

    @abstractmethod
    def publish(
        self,
        topic: str,
        message: str,
        *,
        title: str | None = None,
        id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Publishes and returns the stored envelope. Raises on failure."""

    @abstractmethod
    def subscribe(self, topic: str, handler: RelayHandler, since: str | None = None) -> None:
        """Starts delivering the topic's messages to ``handler`` (from any thread)."""
