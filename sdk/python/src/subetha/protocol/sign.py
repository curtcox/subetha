"""Device identity and signatures (spec §1.3, §4)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .canonical import canonical_envelope
from .encoding import base32_decode, base32_encode, base64url_decode, base64url_encode

SIG_DOMAIN = "subetha-sig-v1\n"
DEVICE_ID_RE = re.compile(r"dev_[a-z2-7]{52}")


@dataclass(frozen=True)
class DeviceKey:
    device_id: str
    public_key: bytes
    private_key: Ed25519PrivateKey = field(repr=False)
    #: 32-byte seed, kept when the key was created or imported from a seed.
    seed: bytes | None = field(default=None, repr=False)

    def sign(self, data: bytes) -> bytes:
        return self.private_key.sign(data)


def device_id_from_public_key(pk: bytes) -> str:
    if len(pk) != 32:
        raise ValueError("ed25519 public key must be 32 bytes")
    return "dev_" + base32_encode(pk)


def public_key_from_device_id(device_id: str) -> bytes:
    if not isinstance(device_id, str) or DEVICE_ID_RE.fullmatch(device_id) is None:
        raise ValueError("invalid device id")
    return base32_decode(device_id[4:])


def is_device_id(s: object) -> bool:
    return isinstance(s, str) and DEVICE_ID_RE.fullmatch(s) is not None


def device_key_from_seed(seed: bytes) -> DeviceKey:
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    sk = Ed25519PrivateKey.from_private_bytes(bytes(seed))
    pk = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return DeviceKey(device_id_from_public_key(pk), pk, sk, bytes(seed))


def generate_device_key() -> DeviceKey:
    return device_key_from_seed(os.urandom(32))


def signing_bytes(env: dict[str, Any]) -> bytes:
    return (SIG_DOMAIN + canonical_envelope(env)).encode("utf-8")


def _is_number(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def sign_envelope(env: dict[str, Any], key: DeviceKey) -> dict[str, Any]:
    """Returns a copy of the envelope with ``sender`` and ``sig`` set."""
    if not isinstance(env.get("id"), str) or not _is_number(env.get("time")):
        raise ValueError("signed messages must carry id and time")
    unsigned = {k: v for k, v in env.items() if k != "sig"}
    unsigned["sender"] = key.device_id
    sig = key.sign(signing_bytes(unsigned))
    return {**unsigned, "sig": "ed25519:" + base64url_encode(sig)}


def verify_envelope(env: dict[str, Any]) -> bool:
    """Verifies ``sig`` against the public key embedded in ``sender``. Never raises."""
    try:
        sig = env.get("sig")
        sender = env.get("sender")
        if not isinstance(sig, str) or not sig.startswith("ed25519:") or not isinstance(sender, str):
            return False
        pk = public_key_from_device_id(sender)
        sig_bytes = base64url_decode(sig[8:])
        if len(sig_bytes) != 64:
            return False
        Ed25519PublicKey.from_public_bytes(pk).verify(sig_bytes, signing_bytes(env))
        return True
    except (InvalidSignature, Exception):  # verification must never raise
        return False
