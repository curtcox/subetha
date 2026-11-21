"""RelayPort over the relay's HTTP API, using the SubEtha Python SDK.

Each subscribed topic gets a daemon thread that consumes the SDK's NDJSON ``subscribe``
generator (which dedupes and reconnects with ``since=<last id>``).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from subetha import Client, SubEthaError

from .ports import RelayHandler, RelayPort

log = logging.getLogger(__name__)


class HttpRelayPort(RelayPort):
    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        *,
        client_factory: Callable[[], Client] | None = None,
        error_backoff: float = 60.0,
    ) -> None:
        self._factory = client_factory or (lambda: Client(base_url, token=token))
        self._client: Client | None = None
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._streams: list[Client] = []
        self.error_backoff = error_backoff

    def start(self) -> None:
        self._stop.clear()
        if self._client is None:
            self._client = self._factory()

    def stop(self) -> None:
        self._stop.set()
        for c in [*self._streams, *([self._client] if self._client else [])]:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
        for t in self._threads:
            t.join(timeout=2)
        self._threads.clear()
        self._streams.clear()
        self._client = None

    def publish(
        self,
        topic: str,
        message: str,
        *,
        title: str | None = None,
        id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self._client is None:
            self.start()
        assert self._client is not None
        return self._client.publish(topic, message, title=title, id=id, extra=extra)

    def subscribe(self, topic: str, handler: RelayHandler, since: str | None = None) -> None:
        # One client per stream so a long-lived response never starves publishes of connections.
        client = self._factory()
        self._streams.append(client)
        t = threading.Thread(
            target=self._run, args=(client, topic, handler, since), name=f"relay-sub {topic}", daemon=True
        )
        self._threads.append(t)
        t.start()

    def _run(self, client: Client, topic: str, handler: RelayHandler, since: str | None) -> None:
        last = since
        while not self._stop.is_set():
            try:
                for msg in client.subscribe(topic, since=last, stop=self._stop):
                    if isinstance(msg.get("id"), str):
                        last = msg["id"]
                    try:
                        handler(msg)
                    except Exception:  # noqa: BLE001 - keep the stream alive
                        log.exception("handler failed for message %s on %s", msg.get("id"), topic)
            except SubEthaError as e:
                log.error("subscription to %s failed: %s; retrying in %ss", topic, e, self.error_backoff)
            except Exception:  # noqa: BLE001
                if self._stop.is_set():
                    return
                log.exception("subscription to %s crashed; retrying in %ss", topic, self.error_backoff)
            if self._stop.wait(self.error_backoff):
                return
