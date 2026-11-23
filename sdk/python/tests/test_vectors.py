"""Checks the Python SDK against the conformance vectors in spec/vectors (exact equality)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from subetha.protocol import (
    CanonicalError,
    canonical_envelope,
    canonicalize,
    decrypt_envelope,
    device_key_from_seed,
    e2ee_aad,
    encrypt_envelope,
    hex_decode,
    is_topic,
    headers_to_sign,
    request_signing_input,
    sign_envelope,
    sign_request,
    signing_bytes,
    validate_envelope,
    verify_envelope,
)

VECTORS = Path(__file__).resolve().parents[3] / "spec" / "vectors"
KNOWN = {"canonical.json", "e2ee.json", "requests.json", "signatures.json", "topics.json"}
# Edge framings (spec §11) run on devices; the Python SDK talks to the relay only.
NOT_APPLICABLE = {"edge.json"}


def load(name: str):
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


def test_every_vector_file_is_covered():
    found = {p.name for p in VECTORS.glob("*.json")} - NOT_APPLICABLE
    assert found == KNOWN, f"new or missing vector files: {found ^ KNOWN}"


# ---- canonical ----

CANON = load("canonical.json")


@pytest.mark.parametrize("case", CANON["valid"], ids=[c["name"] for c in CANON["valid"]])
def test_canonical_valid(case):
    assert canonicalize(case["input"]) == case["canonical"]


@pytest.mark.parametrize("case", CANON["invalid"], ids=[c["name"] for c in CANON["invalid"]])
def test_canonical_invalid(case):
    with pytest.raises(CanonicalError):
        canonicalize(json.loads(case["input_json"]))


# ---- topics ----

TOPICS = load("topics.json")


@pytest.mark.parametrize("topic", TOPICS["valid"])
def test_topic_valid(topic):
    assert is_topic(topic)
    assert validate_envelope({"topic": topic}) == []


@pytest.mark.parametrize("topic", TOPICS["invalid"])
def test_topic_invalid(topic):
    assert not is_topic(topic)
    assert validate_envelope({"topic": topic}) != []


# ---- signatures ----

SIGS = load("signatures.json")


@pytest.mark.parametrize("device", SIGS["devices"], ids=[d["device_id"][:12] for d in SIGS["devices"]])
def test_device_ids(device):
    k = device_key_from_seed(hex_decode(device["seed"]))
    assert k.public_key.hex() == device["public_key"]
    assert k.device_id == device["device_id"]


@pytest.mark.parametrize("case", SIGS["cases"], ids=[c["unsigned"]["id"] for c in SIGS["cases"]])
def test_signature_cases(case):
    k = device_key_from_seed(hex_decode(case["seed"]))
    unsigned = copy.deepcopy(case["unsigned"])
    signed = sign_envelope(unsigned, k)
    assert signed == case["signed"]
    assert unsigned == case["unsigned"], "sign_envelope must not mutate its input"
    assert canonical_envelope(signed) == case["canonical"]
    assert signing_bytes(signed) == case["signing_input"].encode("utf-8")
    assert verify_envelope(case["signed"]) is True
    assert validate_envelope(case["signed"]) == []


def test_hops_change_keeps_validity():
    assert verify_envelope(SIGS["hops_change"]["envelope"]) is SIGS["hops_change"]["valid"]
    assert verify_envelope(SIGS["event_added"]["envelope"]) is SIGS["event_added"]["valid"]


@pytest.mark.parametrize("case", SIGS["negative"], ids=[n["name"] for n in SIGS["negative"]])
def test_negative_signatures(case):
    assert verify_envelope(case["envelope"]) is False


# ---- e2ee ----

E2EE = load("e2ee.json")


def test_e2ee_nonce_encoding():
    from subetha.protocol import base64url_encode

    assert base64url_encode(hex_decode(E2EE["nonce"])) == E2EE["nonce_b64"]


def test_e2ee_encrypts_deterministically():
    enc = encrypt_envelope(copy.deepcopy(E2EE["plaintext"]), hex_decode(E2EE["key"]), E2EE["kid"], hex_decode(E2EE["nonce"]))
    assert enc == E2EE["encrypted"]
    assert e2ee_aad(enc) == E2EE["aad"].encode("utf-8")


def test_e2ee_decrypts():
    assert decrypt_envelope(E2EE["encrypted"], hex_decode(E2EE["key"])) == E2EE["plaintext"]


def test_e2ee_wrong_key_or_tamper_fails():
    key = hex_decode(E2EE["key"])
    assert decrypt_envelope(E2EE["encrypted"], bytes(32)) is None
    tampered = copy.deepcopy(E2EE["encrypted"])
    tampered["priority"] = 4  # covered by the AAD
    assert decrypt_envelope(tampered, key) is None


def test_e2ee_signed_verifies():
    assert verify_envelope(E2EE["encrypted_signed"]) is True
    assert validate_envelope(E2EE["encrypted_signed"]) == []
    k = device_key_from_seed(hex_decode(SIGS["devices"][0]["seed"]))
    assert sign_envelope(E2EE["encrypted"], k) == E2EE["encrypted_signed"]


def test_e2ee_signed_decrypts():
    assert decrypt_envelope(E2EE["encrypted_signed"], hex_decode(E2EE["key"])) == E2EE["decrypted_signed"]


def test_e2ee_aad_excludes_sender_sig_hops():
    expected = E2EE["aad"].encode("utf-8")
    assert e2ee_aad(E2EE["encrypted"]) == expected
    assert e2ee_aad(E2EE["encrypted_signed"]) == expected
    assert e2ee_aad({**E2EE["encrypted_signed"], "hops": 3}) == expected


# ---- device-signed requests (spec §8.1) ----

REQS = load("requests.json")


@pytest.mark.parametrize("case", REQS["cases"], ids=[c["name"] for c in REQS["cases"]])
def test_request_signing(case):
    key = device_key_from_seed(hex_decode(REQS["seed"]))
    assert key.device_id == REQS["device_id"]
    body = case["body"].encode("utf-8")
    signed = headers_to_sign(key.device_id, case["time"], REQS["nonce"], case["headers"])
    assert request_signing_input(case["method"], case["url"], body, signed) == case["signing_input"]
    h = sign_request(key, case["method"], case["url"], body, case["headers"], time=case["time"], nonce=REQS["nonce"])
    assert h["X-Device-Signed-Headers"] == case["signed_headers"]
    assert h["X-Device-Signature"] == case["signature"]


# ---- wrapped topic keys (spec §5.1) ----

WRAP = E2EE["key_wrap"]


def test_key_wrap_deterministic_and_unwraps():
    from subetha.protocol import device_key_from_seed, ed25519_to_x25519_public, unwrap_topic_key, wrap_aad, wrap_topic_key, x25519_secret_from_seed

    seed = hex_decode(WRAP["recipient_seed"])
    dev = device_key_from_seed(seed)
    assert ed25519_to_x25519_public(dev.public_key).hex() == WRAP["recipient_x25519_public"]
    assert x25519_secret_from_seed(seed).hex() == WRAP["recipient_x25519_secret"]
    w = wrap_topic_key(hex_decode(E2EE["key"]), WRAP["wrapped"]["topic"], WRAP["wrapped"]["kid"], dev.device_id,
                       ephemeral_secret=hex_decode(WRAP["ephemeral_secret"]), nonce=hex_decode(WRAP["nonce"]))
    assert w == WRAP["wrapped"]
    assert wrap_aad(w) == WRAP["aad"].encode("utf-8")
    assert unwrap_topic_key(WRAP["wrapped"], dev) == hex_decode(E2EE["key"])
    assert unwrap_topic_key(WRAP["wrapped"], seed) == hex_decode(E2EE["key"])


@pytest.mark.parametrize("case", WRAP["invalid"], ids=lambda c: c["name"])
def test_key_wrap_invalid(case):
    from subetha.protocol import unwrap_topic_key

    assert unwrap_topic_key(case["wrapped"], hex_decode(WRAP["recipient_seed"])) is None


def test_ed25519_to_x25519():
    from subetha.protocol import ed25519_to_x25519_public

    for c in WRAP["ed25519_to_x25519"]:
        assert ed25519_to_x25519_public(hex_decode(c["ed25519"])).hex() == c["x25519"]
