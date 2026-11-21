"""Byte encodings used by the protocol (mirrors sdk/js/src/protocol/encoding.ts)."""

from __future__ import annotations

_B32 = "abcdefghijklmnopqrstuvwxyz234567"
_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def base32_encode(data: bytes) -> str:
    """RFC 4648 base32, lowercase, no padding."""
    out = []
    bits = 0
    value = 0
    for b in data:
        value = ((value << 8) | b) & 0xFFFF
        bits += 8
        while bits >= 5:
            out.append(_B32[(value >> (bits - 5)) & 31])
            bits -= 5
    if bits > 0:
        out.append(_B32[(value << (5 - bits)) & 31])
    return "".join(out)


def base32_decode(s: str) -> bytes:
    """Decodes RFC 4648 base32 (either case, padding optional)."""
    s = s.lower().rstrip("=")
    out = bytearray()
    bits = 0
    value = 0
    for ch in s:
        i = _B32.find(ch)
        if i < 0:
            raise ValueError(f"invalid base32 character: {ch!r}")
        value = ((value << 5) | i) & 0xFFFF
        bits += 5
        if bits >= 8:
            out.append((value >> (bits - 8)) & 255)
            bits -= 8
    return bytes(out)


def base64url_encode(data: bytes) -> str:
    """base64url without padding."""
    out = []
    n = len(data)
    i = 0
    while i + 2 < n:
        v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
        out.append(_B64[v >> 18] + _B64[(v >> 12) & 63] + _B64[(v >> 6) & 63] + _B64[v & 63])
        i += 3
    rem = n - i
    if rem == 1:
        v = data[i] << 16
        out.append(_B64[v >> 18] + _B64[(v >> 12) & 63])
    elif rem == 2:
        v = (data[i] << 16) | (data[i + 1] << 8)
        out.append(_B64[v >> 18] + _B64[(v >> 12) & 63] + _B64[(v >> 6) & 63])
    return "".join(out)


def base64url_decode(s: str) -> bytes:
    """Accepts base64url or standard base64, with or without padding."""
    s = s.rstrip("=").replace("+", "-").replace("/", "_")
    out = bytearray()
    bits = 0
    value = 0
    for ch in s:
        i = _B64.find(ch)
        if i < 0:
            raise ValueError(f"invalid base64 character: {ch!r}")
        value = ((value << 6) | i) & 0xFFFF
        bits += 6
        if bits >= 8:
            out.append((value >> (bits - 8)) & 255)
            bits -= 8
    return bytes(out)


def hex_encode(data: bytes) -> str:
    return data.hex()


def hex_decode(s: str) -> bytes:
    if len(s) % 2:
        raise ValueError("odd hex length")
    return bytes.fromhex(s)
