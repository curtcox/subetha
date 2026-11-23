"""SubEtha protocol primitives (spec/README.md). Mirrors sdk/js/src/protocol."""

from .canonical import MAX_SAFE_INTEGER, CanonicalError, canonical_envelope, canonicalize
from .encoding import base32_decode, base32_encode, base64url_decode, base64url_encode, hex_decode, hex_encode
from .envelope import (
    CONTENT_TYPES,
    EDGE_TRANSPORTS,
    MAX_MESSAGE_BYTES,
    PRIORITY_NAMES,
    PROTECTED_FIELDS,
    ROUTE_MODES,
    TRANSPORTS,
    Deduper,
    Envelope,
    decrypt_envelope,
    e2ee_aad,
    encrypt_envelope,
    parse_priority,
    validate_envelope,
)
from .sign import (
    DEVICE_ID_RE,
    SIG_DOMAIN,
    DeviceKey,
    device_id_from_public_key,
    device_key_from_seed,
    generate_device_key,
    is_device_id,
    public_key_from_device_id,
    sign_envelope,
    signing_bytes,
    verify_envelope,
)
from .request import (
    COVERED_REQUEST_HEADERS,
    UNSIGNED_BY_CONVENTION,
    headers_to_sign,
    new_request_nonce,
    request_signing_input,
    sign_request,
)
from .topic import HANDLE_RE, TOPIC_RE, ParsedTopic, is_topic, parse_topic, secret_topic
from .ulid import ULID_RE, is_ulid, ulid, ulid_time
from .xchacha import hchacha20, xchacha_open, xchacha_seal
from .keywrap import (
    KID_RE,
    WRAP_ALG,
    ed25519_to_x25519_public,
    unwrap_topic_key,
    wrap_aad,
    wrap_topic_key,
    x25519_secret_from_seed,
)

__all__ = [
    "COVERED_REQUEST_HEADERS", "UNSIGNED_BY_CONVENTION", "headers_to_sign", "new_request_nonce",
    "request_signing_input", "sign_request",
    "CONTENT_TYPES", "DEVICE_ID_RE", "EDGE_TRANSPORTS", "HANDLE_RE", "MAX_MESSAGE_BYTES", "MAX_SAFE_INTEGER",
    "PRIORITY_NAMES", "PROTECTED_FIELDS", "ROUTE_MODES", "SIG_DOMAIN", "TOPIC_RE", "TRANSPORTS", "ULID_RE",
    "CanonicalError", "Deduper", "DeviceKey", "Envelope", "ParsedTopic",
    "base32_decode", "base32_encode", "base64url_decode", "base64url_encode", "canonical_envelope",
    "canonicalize", "decrypt_envelope", "device_id_from_public_key", "e2ee_aad", "device_key_from_seed",
    "encrypt_envelope", "generate_device_key", "hchacha20", "hex_decode", "hex_encode", "is_device_id",
    "is_topic", "is_ulid", "parse_priority", "parse_topic", "public_key_from_device_id", "secret_topic",
    "sign_envelope", "signing_bytes", "ulid", "ulid_time", "validate_envelope", "verify_envelope",
    "xchacha_open", "xchacha_seal",
    "KID_RE", "WRAP_ALG", "ed25519_to_x25519_public", "unwrap_topic_key", "wrap_aad", "wrap_topic_key",
    "x25519_secret_from_seed",
]
