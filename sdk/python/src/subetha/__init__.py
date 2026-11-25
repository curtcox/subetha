"""SubEtha Python SDK: protocol primitives and an HTTP client for the relay."""

__version__ = "0.1.0"

from .client import DEFAULT_BASE_URL, Client, DbaAuth, DeviceAuth  # noqa: E402
from .errors import SubEthaError  # noqa: E402

SubEtha = Client
from .protocol import (  # noqa: E402
    Deduper,
    DeviceKey,
    decrypt_envelope,
    device_key_from_seed,
    encrypt_envelope,
    enrollment_proof,
    generate_device_key,
    is_topic,
    secret_topic,
    sign_envelope,
    sign_request,
    ulid,
    validate_envelope,
    verify_envelope,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "Client",
    "SubEtha",
    "DbaAuth",
    "Deduper",
    "DeviceAuth",
    "DeviceKey",
    "SubEthaError",
    "__version__",
    "decrypt_envelope",
    "device_key_from_seed",
    "encrypt_envelope",
    "enrollment_proof",
    "generate_device_key",
    "is_topic",
    "secret_topic",
    "sign_envelope",
    "sign_request",
    "ulid",
    "validate_envelope",
    "verify_envelope",
]
