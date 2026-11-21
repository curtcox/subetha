"""ULID generation (spec §1.1). Monotonic within a millisecond."""

from __future__ import annotations

import os
import re
import threading
import time

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ULID_RE = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}", re.IGNORECASE)

_lock = threading.Lock()
_last_time = -1
_last_random: list[int] = []


def ulid(now_ms: int | None = None) -> str:
    """A new ULID. ``now_ms`` defaults to the current time in milliseconds."""
    global _last_time, _last_random
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    with _lock:
        if now == _last_time:
            rand = list(_last_random)
            for i in range(15, -1, -1):
                if rand[i] < 31:
                    rand[i] += 1
                    break
                rand[i] = 0
        else:
            rand = [b & 31 for b in os.urandom(16)]
        _last_time = now
        _last_random = rand
    t = []
    n = now
    for _ in range(10):
        t.append(CROCKFORD[n % 32])
        n //= 32
    return "".join(reversed(t)) + "".join(CROCKFORD[d] for d in rand)


def ulid_time(id_: str) -> int:
    """The millisecond timestamp encoded in a ULID."""
    n = 0
    for ch in id_[:10].upper():
        v = CROCKFORD.find(ch)
        if v < 0:
            raise ValueError("invalid ulid")
        n = n * 32 + v
    return n


def is_ulid(s: object) -> bool:
    return isinstance(s, str) and ULID_RE.fullmatch(s) is not None
