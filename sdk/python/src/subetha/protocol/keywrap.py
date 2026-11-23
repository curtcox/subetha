"""Wrapped topic keys (spec §5.1): a 32-byte E2EE topic key sealed to one device's identity key.

X25519 against the Montgomery form of the device's Ed25519 key, a SHA-256 KDF, and
XChaCha20-Poly1305. Mirrors ``wrapTopicKey`` / ``unwrapTopicKey`` in the TS reference.
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption

from .canonical import canonicalize
from .encoding import base64url_decode, base64url_encode
from .sign import DeviceKey, public_key_from_device_id
from .topic import is_topic
from .xchacha import xchacha_open, xchacha_seal

WRAP_ALG = "x25519-xchacha20poly1305"
WRAP_DOMAIN = b"subetha-wrap-v1\n"
KID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def ed25519_to_x25519_public(pk: bytes) -> bytes:
    """Montgomery u = (1 + y) / (1 - y) of an Ed25519 public key; raises if it isn't a curve point."""
    if len(pk) != 32:
        raise ValueError("ed25519 public key must be 32 bytes")
    y = (int.from_bytes(pk, "little") & ((1 << 255) - 1)) % _P
    y2 = y * y % _P
    x2 = (y2 - 1) * pow((_D * y2 + 1) % _P, _P - 2, _P) % _P
    if x2 != 0 and pow(x2, (_P - 1) // 2, _P) != 1:
        raise ValueError("not a valid ed25519 public key")
    u = (1 + y) * pow((1 - y) % _P, _P - 2, _P) % _P  # pow(0, p-2) == 0, as in curve25519-dalek
    return u.to_bytes(32, "little")


def x25519_secret_from_seed(seed: bytes) -> bytes:
    """The first 32 bytes of SHA-512(seed); X25519 clamps it."""
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    return hashlib.sha512(seed).digest()[:32]


def _x25519(secret: bytes, u: bytes) -> bytes:
    try:
        shared = X25519PrivateKey.from_private_bytes(secret).exchange(X25519PublicKey.from_public_bytes(u))
    except ValueError as e:  # cryptography refuses an all-zero result
        raise ValueError("x25519 failed (low-order public key)") from e
    if shared == bytes(32):
        raise ValueError("x25519 failed (low-order public key)")
    return shared


def _kdf(shared: bytes, epk: bytes, rpk: bytes) -> bytes:
    return hashlib.sha256(WRAP_DOMAIN + shared + epk + rpk).digest()


def wrap_aad(w: dict[str, Any]) -> bytes:
    """Canonical form of the wrapped-key object without ``ct``."""
    return canonicalize({k: w[k] for k in ("alg", "epk", "kid", "nonce", "to", "topic")}).encode("utf-8")


def wrap_topic_key(key: bytes, topic: str, kid: str, to: str, *, ephemeral_secret: bytes | None = None, nonce: bytes | None = None) -> dict[str, str]:
    """Seals ``key`` for device ``to``. ``ephemeral_secret`` and ``nonce`` are for test vectors."""
    if len(key) != 32:
        raise ValueError("topic key must be 32 bytes")
    if not is_topic(topic):
        raise ValueError("invalid topic")
    if not KID_RE.match(kid):
        raise ValueError("kid must be 1-64 characters of A-Z a-z 0-9 _ . -")
    rpk = ed25519_to_x25519_public(public_key_from_device_id(to))
    esk = ephemeral_secret if ephemeral_secret is not None else os.urandom(32)
    epk = X25519PrivateKey.from_private_bytes(esk).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    k = _kdf(_x25519(esk, rpk), epk, rpk)
    n = nonce if nonce is not None else os.urandom(24)
    w = {"alg": WRAP_ALG, "topic": topic, "kid": kid, "to": to, "epk": base64url_encode(epk), "nonce": base64url_encode(n)}
    w["ct"] = base64url_encode(xchacha_seal(k, n, key, wrap_aad(w)))
    return w


def _seed_of(device: DeviceKey | bytes) -> bytes:
    if isinstance(device, (bytes, bytearray)):
        return bytes(device)
    if device.seed is not None:
        return device.seed
    return device.private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())


def unwrap_topic_key(w: dict[str, Any], device: DeviceKey | bytes) -> bytes | None:
    """Opens a wrapped key with the recipient's device key or seed; None if it isn't for this
    device, is malformed, or was tampered with."""
    try:
        if w.get("alg") != WRAP_ALG or not is_topic(w.get("topic")) or not KID_RE.match(str(w.get("kid", ""))):
            return None
        seed = _seed_of(device)
        secret = x25519_secret_from_seed(seed)
        mine = ed25519_to_x25519_public(Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))
        rpk = ed25519_to_x25519_public(public_key_from_device_id(w["to"]))
        if rpk != mine:
            return None
        epk = base64url_decode(w["epk"])
        n = base64url_decode(w["nonce"])
        if len(epk) != 32 or len(n) != 24:
            return None
        key = xchacha_open(_kdf(_x25519(secret, epk), epk, rpk), n, base64url_decode(w["ct"]), wrap_aad(w))
        return key if key is not None and len(key) == 32 else None
    except (ValueError, KeyError, TypeError):
        return None
