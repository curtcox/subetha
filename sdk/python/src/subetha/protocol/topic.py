"""Topic grammar (spec §1.2)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from .encoding import base32_encode

HANDLE_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?")
TOPIC_RE = re.compile(r"(@[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?/[A-Za-z0-9_-]{1,64}|t_[a-z2-7]{26})")


@dataclass(frozen=True)
class ParsedTopic:
    kind: str  # "namespaced" or "secret"
    topic: str
    handle: str | None = None
    name: str | None = None


def is_topic(s: object) -> bool:
    return isinstance(s, str) and TOPIC_RE.fullmatch(s) is not None


def parse_topic(topic: str) -> ParsedTopic | None:
    if not is_topic(topic):
        return None
    if topic.startswith("t_"):
        return ParsedTopic("secret", topic)
    slash = topic.index("/")
    return ParsedTopic("namespaced", topic, topic[1:slash], topic[slash + 1 :])


def secret_topic() -> str:
    """A fresh unguessable secret topic (128 random bits)."""
    return "t_" + base32_encode(os.urandom(16))
