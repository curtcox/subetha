"""LxmfPort backed by the real Reticulum (``rns``) and ``lxmf`` packages.

Both are imported lazily, on ``start()``, so the rest of the gateway (and its tests) work
without them. Install with ``pip install "subetha-reticulum-gateway[rns]"``.

LXMF routers support one delivery identity each, so every topic gets its own ``LXMRouter``
(sharing the one Reticulum instance) and its own identity file under ``<data_dir>/identities``.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ports import LxmfHandler, LxmfMessage, LxmfPort

log = logging.getLogger(__name__)

DELIVERY_METHODS = ("direct", "opportunistic", "propagated")


def topic_slug(topic: str) -> str:
    """A filesystem-safe, collision-free name for a topic (handles never contain ``_``)."""
    return topic.lstrip("@").replace("/", "__")


@dataclass
class _Outbound:
    from_topic: str
    to: str
    content: str
    title: str
    deadline: float
    next_try: float = 0.0


class RnsLxmfPort(LxmfPort):
    def __init__(
        self,
        data_dir: str | Path,
        *,
        reticulum_config_dir: str | Path | None = None,
        propagation_node: str | None = None,
        delivery_method: str = "direct",
        stamp_cost: int | None = None,
        path_timeout: float = 600.0,
        retry_interval: float = 5.0,
    ) -> None:
        if delivery_method not in DELIVERY_METHODS:
            raise ValueError(f"delivery_method must be one of {DELIVERY_METHODS}")
        if delivery_method == "propagated" and not propagation_node:
            raise ValueError("delivery_method 'propagated' needs propagation_node")
        self.data_dir = Path(data_dir)
        self.reticulum_config_dir = Path(reticulum_config_dir) if reticulum_config_dir else None
        self.propagation_node = propagation_node
        self.delivery_method = delivery_method
        self.stamp_cost = stamp_cost
        self.path_timeout = path_timeout
        self.retry_interval = retry_interval
        self._handler: LxmfHandler | None = None
        self._topics: dict[str, tuple[Any, Any]] = {}  # topic -> (router, delivery destination)
        self._queue: queue.Queue[_Outbound] = queue.Queue()
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self.RNS: Any = None
        self.LXMF: Any = None
        self._reticulum: Any = None

    # ---- lifecycle ----

    def start(self) -> None:
        if self._reticulum is not None:
            return
        try:
            import LXMF  # noqa: N811
            import RNS  # noqa: N811
        except ImportError as e:  # pragma: no cover - depends on the optional extra
            raise RuntimeError('Reticulum support needs: pip install "subetha-reticulum-gateway[rns]"') from e
        self.RNS, self.LXMF = RNS, LXMF
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._reticulum = RNS.Reticulum(str(self.reticulum_config_dir) if self.reticulum_config_dir else None)
        self._stop.clear()
        self._worker = threading.Thread(target=self._send_loop, name="lxmf-send", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        if self._worker is not None:
            self._worker.join(timeout=2)
        for router, _ in self._topics.values():
            try:
                router.exit_handler()
            except Exception:  # noqa: BLE001
                pass

    def set_handler(self, handler: LxmfHandler) -> None:
        self._handler = handler

    # ---- destinations ----

    def _identity(self, topic: str) -> Any:
        RNS = self.RNS
        path = self.data_dir / "identities" / f"{topic_slug(topic)}.identity"
        if path.exists():
            identity = RNS.Identity.from_file(str(path))
            if identity is None:
                raise RuntimeError(f"could not load identity {path}")
            return identity
        path.parent.mkdir(parents=True, exist_ok=True)
        identity = RNS.Identity()
        identity.to_file(str(path))
        return identity

    def register_topic(self, topic: str, display_name: str) -> str:
        if self._reticulum is None:
            self.start()
        RNS, LXMF = self.RNS, self.LXMF
        identity = self._identity(topic)
        storage = self.data_dir / "lxmf" / topic_slug(topic)
        storage.mkdir(parents=True, exist_ok=True)
        router = LXMF.LXMRouter(identity=identity, storagepath=str(storage))
        dest = router.register_delivery_identity(identity, display_name=display_name, stamp_cost=self.stamp_cost)
        if dest is None:
            raise RuntimeError(f"LXMF refused the delivery identity for {topic}")
        router.register_delivery_callback(lambda m, t=topic: self._on_message(t, m))
        if self.propagation_node:
            router.set_outbound_propagation_node(bytes.fromhex(self.propagation_node))
        self._topics[topic] = (router, dest)
        return RNS.hexrep(dest.hash, delimit=False)

    def announce(self, topic: str | None = None) -> None:
        for t, (router, dest) in self._topics.items():
            if topic is None or t == topic:
                router.announce(dest.hash)

    # ---- inbound ----

    def _on_message(self, topic: str, m: Any) -> None:
        RNS, LXMF = self.RNS, self.LXMF
        reason = getattr(m, "unverified_reason", None)
        if reason == LXMF.LXMessage.SIGNATURE_INVALID:
            log.warning("dropping LXMF message on %s with an invalid signature", topic)
            return
        verified = bool(getattr(m, "signature_validated", False))
        if not verified:
            # Learn the sender's identity so replies (and its next message) can be verified.
            RNS.Transport.request_path(m.source_hash)
        try:
            msg = LxmfMessage(
                destination=RNS.hexrep(m.destination_hash, delimit=False),
                source=RNS.hexrep(m.source_hash, delimit=False),
                content=m.content_as_string() or "",
                title=m.title_as_string() or "",
                message_id=RNS.hexrep(m.hash, delimit=False) if getattr(m, "hash", None) else None,
                fields=dict(m.fields or {}),
                verified=verified,
            )
        except Exception:  # noqa: BLE001
            log.exception("could not decode LXMF message on %s", topic)
            return
        if self._handler is not None:
            try:
                self._handler(msg)
            except Exception:  # noqa: BLE001
                log.exception("bridge failed on LXMF message %s", msg.message_id)

    # ---- outbound ----

    def send(self, from_topic: str, to: str, content: str, title: str = "") -> None:
        if from_topic not in self._topics:
            raise KeyError(f"unknown topic {from_topic}")
        bytes.fromhex(to)  # validate early
        self._queue.put(_Outbound(from_topic, to, content, title, time.monotonic() + self.path_timeout))

    def _send_loop(self) -> None:
        waiting: list[_Outbound] = []
        while not self._stop.is_set():
            try:
                waiting.append(self._queue.get(timeout=1.0))
            except queue.Empty:
                pass
            now = time.monotonic()
            still: list[_Outbound] = []
            for item in waiting:
                if item.next_try > now:
                    still.append(item)
                    continue
                try:
                    if not self._try_send(item):
                        if now > item.deadline:
                            log.warning("no path to %s; dropping message", item.to)
                        else:
                            item.next_try = now + self.retry_interval
                            still.append(item)
                except Exception:  # noqa: BLE001
                    log.exception("LXMF send to %s failed", item.to)
            waiting = still

    def _try_send(self, item: _Outbound) -> bool:
        RNS, LXMF = self.RNS, self.LXMF
        dest_hash = bytes.fromhex(item.to)
        identity = RNS.Identity.recall(dest_hash)
        if identity is None:
            if item.next_try == 0.0 or not RNS.Transport.has_path(dest_hash):
                RNS.Transport.request_path(dest_hash)
            return False
        router, source = self._topics[item.from_topic]
        out = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxmf", "delivery")
        method = {
            "direct": LXMF.LXMessage.DIRECT,
            "opportunistic": LXMF.LXMessage.OPPORTUNISTIC,
            "propagated": LXMF.LXMessage.PROPAGATED,
        }[self.delivery_method]
        message = LXMF.LXMessage(out, source, item.content, item.title, desired_method=method)
        router.handle_outbound(message)
        return True
