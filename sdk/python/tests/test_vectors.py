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
    encrypt_envelope,
    hex_decode,
    is_topic,
    sign_envelope,
    signing_bytes,
    validate_envelope,
    verify_envelope,
)

VECTORS = Path(__file__).resolve().parents[3] / "spec" / "vectors"
KNOWN = {"canonical.json", "e2ee.json", "signatures.json", "topics.json"}


def load(name: str):
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


def test_every_vector_file_is_covered():
    found = {p.name for p in VECTORS.glob("*.json")}
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
    without_message = {k: v for k, v in enc.items() if k != "message"}
    assert canonical_envelope(without_message) == E2EE["aad"]


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


@pytest.mark.xfail(
    reason=(
        "Spec issue: §5 puts the whole envelope (minus message/sig/hops) in the AAD and §4 signs "
        "after encrypting, so a `sender` added at signing time is not in the AAD used at "
        "encryption time. The TS reference also returns null here."
    ),
    strict=False,
)
def test_e2ee_signed_decrypts():
    assert decrypt_envelope(E2EE["encrypted_signed"], hex_decode(E2EE["key"])) is not None
