"""Canonical JSON (spec §3): a strict subset of RFC 8785.

Mirrors sdk/js/src/protocol/canonical.ts. Because the TypeScript reference parses JSON into
IEEE doubles, a float with an integral value (``1.0``, ``1e2``) is accepted and emitted as an
integer there; this implementation does the same so both produce identical bytes.
"""

from __future__ import annotations

from typing import Any

MAX_SAFE_INTEGER = 2**53 - 1

_SHORT_ESCAPES = {
    0x22: '\\"',
    0x5C: "\\\\",
    0x08: "\\b",
    0x0C: "\\f",
    0x0A: "\\n",
    0x0D: "\\r",
    0x09: "\\t",
}


class CanonicalError(ValueError):
    """Raised when a value cannot be canonicalized (floats, unsafe ints, bad keys, ...)."""


def _escape_string(s: str) -> str:
    out = ['"']
    for ch in s:
        c = ord(ch)
        esc = _SHORT_ESCAPES.get(c)
        if esc is not None:
            out.append(esc)
        elif c < 0x20:
            out.append("\\u%04x" % c)
        elif 0xD800 <= c <= 0xDFFF:
            # json.loads joins valid surrogate pairs, so anything left here is a lone surrogate.
            raise CanonicalError("lone surrogate in string")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _integer(value: int | float) -> int:
    if isinstance(value, float):
        if not value.is_integer():
            raise CanonicalError(f"non-integer or unsafe number: {value!r}")
        value = int(value)
    if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
        raise CanonicalError(f"non-integer or unsafe number: {value!r}")
    return value


def _is_ascii_printable(key: str) -> bool:
    return all(0x20 <= ord(ch) <= 0x7E for ch in key)


def canonicalize(value: Any) -> str:
    """Serialize a JSON value canonically. ``None`` values inside objects are dropped."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return str(_integer(value))  # -0.0 becomes 0
    if isinstance(value, str):
        return _escape_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = [k for k, v in value.items() if v is not None]
        for k in keys:
            if not isinstance(k, str) or not _is_ascii_printable(k):
                raise CanonicalError(f"non-ASCII object key: {k!r}")
        parts = [_escape_string(k) + ":" + canonicalize(value[k]) for k in sorted(keys)]
        return "{" + ",".join(parts) + "}"
    raise CanonicalError(f"unsupported type: {type(value).__name__}")


def canonical_envelope(env: dict[str, Any]) -> str:
    """Canonical form of an envelope for signing and AAD: drops ``sig`` and ``hops``."""
    return canonicalize({k: v for k, v in env.items() if k not in ("sig", "hops", "event")})
