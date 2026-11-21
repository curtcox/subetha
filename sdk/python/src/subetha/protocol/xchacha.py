"""XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha) built from a pure-Python HChaCha20 and the
IETF ChaCha20-Poly1305 AEAD from ``cryptography``."""

from __future__ import annotations

import struct

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

_SIGMA = (0x61707865, 0x3320646E, 0x79622D32, 0x6B206574)
_M = 0xFFFFFFFF


def _rotl(x: int, n: int) -> int:
    return ((x << n) | (x >> (32 - n))) & _M


def _quarter(s: list[int], a: int, b: int, c: int, d: int) -> None:
    s[a] = (s[a] + s[b]) & _M
    s[d] = _rotl(s[d] ^ s[a], 16)
    s[c] = (s[c] + s[d]) & _M
    s[b] = _rotl(s[b] ^ s[c], 12)
    s[a] = (s[a] + s[b]) & _M
    s[d] = _rotl(s[d] ^ s[a], 8)
    s[c] = (s[c] + s[d]) & _M
    s[b] = _rotl(s[b] ^ s[c], 7)


def hchacha20(key: bytes, nonce16: bytes) -> bytes:
    """HChaCha20: derives a 32-byte subkey from a 32-byte key and a 16-byte nonce."""
    if len(key) != 32:
        raise ValueError("key must be 32 bytes")
    if len(nonce16) != 16:
        raise ValueError("hchacha20 nonce must be 16 bytes")
    s = list(_SIGMA) + list(struct.unpack("<8I", key)) + list(struct.unpack("<4I", nonce16))
    for _ in range(10):
        _quarter(s, 0, 4, 8, 12)
        _quarter(s, 1, 5, 9, 13)
        _quarter(s, 2, 6, 10, 14)
        _quarter(s, 3, 7, 11, 15)
        _quarter(s, 0, 5, 10, 15)
        _quarter(s, 1, 6, 11, 12)
        _quarter(s, 2, 7, 8, 13)
        _quarter(s, 3, 4, 9, 14)
    return struct.pack("<8I", *(s[0:4] + s[12:16]))


def _subkey_and_nonce(key: bytes, nonce24: bytes) -> tuple[bytes, bytes]:
    if len(key) != 32:
        raise ValueError("key must be 32 bytes")
    if len(nonce24) != 24:
        raise ValueError("nonce must be 24 bytes")
    return hchacha20(key, nonce24[:16]), b"\x00\x00\x00\x00" + nonce24[16:]


def xchacha_seal(key: bytes, nonce24: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """Returns ciphertext || 16-byte tag."""
    subkey, nonce12 = _subkey_and_nonce(key, nonce24)
    return ChaCha20Poly1305(subkey).encrypt(nonce12, plaintext, aad)


def xchacha_open(key: bytes, nonce24: bytes, sealed: bytes, aad: bytes) -> bytes | None:
    """Returns the plaintext, or None if authentication fails."""
    if len(sealed) < 16:
        return None
    subkey, nonce12 = _subkey_and_nonce(key, nonce24)
    try:
        return ChaCha20Poly1305(subkey).decrypt(nonce12, sealed, aad)
    except InvalidTag:
        return None
