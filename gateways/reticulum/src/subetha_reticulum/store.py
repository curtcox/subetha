"""Persistent gateway state: LXMF subscribers per topic and the relay cursor (last message id)."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


class SubscriberStore:
    """Thread-safe; persisted as JSON when ``path`` is given, in memory otherwise."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path is not None else None
        self._lock = threading.Lock()
        self._topics: dict[str, dict[str, Any]] = {}
        if self.path is not None and self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for topic, t in data.get("topics", {}).items():
                self._topics[topic] = {
                    "subscribers": sorted(set(t.get("subscribers", []))),
                    "cursor": t.get("cursor"),
                }

    def _topic(self, topic: str) -> dict[str, Any]:
        return self._topics.setdefault(topic, {"subscribers": [], "cursor": None})

    def _save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps({"version": 1, "topics": self._topics}, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.path)

    def subscribers(self, topic: str) -> list[str]:
        with self._lock:
            return list(self._topics.get(topic, {}).get("subscribers", []))

    def is_subscribed(self, topic: str, address: str) -> bool:
        return address in self.subscribers(topic)

    def add(self, topic: str, address: str) -> bool:
        """Returns False if already subscribed."""
        with self._lock:
            subs = self._topic(topic)["subscribers"]
            if address in subs:
                return False
            subs.append(address)
            subs.sort()
            self._save()
            return True

    def remove(self, topic: str, address: str) -> bool:
        """Returns False if not subscribed."""
        with self._lock:
            subs = self._topic(topic)["subscribers"]
            if address not in subs:
                return False
            subs.remove(address)
            self._save()
            return True

    def cursor(self, topic: str) -> str | None:
        with self._lock:
            return self._topics.get(topic, {}).get("cursor")

    def set_cursor(self, topic: str, message_id: str) -> None:
        with self._lock:
            t = self._topic(topic)
            if t["cursor"] != message_id:
                t["cursor"] = message_id
                self._save()
