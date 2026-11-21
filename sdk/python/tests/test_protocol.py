"""Unit tests for protocol helpers beyond the conformance vectors."""

from __future__ import annotations

import os

import pytest

from subetha.protocol import (
    Deduper,
    base32_decode,
    base32_encode,
    base64url_decode,
    base64url_encode,
    decrypt_envelope,
    encrypt_envelope,
    generate_device_key,
    hchacha20,
    is_topic,
    is_ulid,
    parse_priority,
    parse_topic,
    public_key_from_device_id,
    secret_topic,
    sign_envelope,
    ulid,
    ulid_time,
    validate_envelope,
    verify_envelope,
)


def test_base32_roundtrip_and_rfc4648():
    assert base32_encode(b"foobar") == "mzxw6ytboi"
    for n in range(0, 40):
        b = os.urandom(n)
        assert base32_decode(base32_encode(b)) == b
        assert base32_decode(base32_encode(b).upper()) == b


def test_base64url_roundtrip_and_standard_alphabet():
    for n in range(0, 40):
        b = os.urandom(n)
        enc = base64url_encode(b)
        assert "=" not in enc
        assert base64url_decode(enc) == b
    assert base64url_decode("+/8=") == base64url_decode("-_8")


def test_hchacha20_draft_vector():
    # draft-irtf-cfrg-xchacha-03 §2.2.1
    key = bytes(range(32))
    nonce = bytes.fromhex("000000090000004a0000000031415927")
    assert hchacha20(key, nonce).hex() == "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc"


def test_ulid_monotonic_and_time():
    ids = [ulid(1763750000000) for _ in range(100)]
    assert ids == sorted(ids)
    assert len(set(ids)) == 100
    assert all(is_ulid(i) for i in ids)
    assert ulid_time(ids[0]) == 1763750000000


def test_secret_topic_and_parse():
    t = secret_topic()
    assert is_topic(t)
    assert parse_topic(t).kind == "secret"
    p = parse_topic("@alice/doorbell")
    assert (p.kind, p.handle, p.name) == ("namespaced", "alice", "doorbell")
    assert parse_topic("nope") is None
    assert not is_topic("@alice/doorbell\n")


def test_validate_envelope():
    assert validate_envelope({"topic": "@a/b", "message": "x", "priority": 4}) == []
    errs = validate_envelope({"topic": "@a/b", "priority": 9, "tags": "x", "hops": 17, "time": 1.5, "route": {"deny": ["pigeon"]}})
    joined = " ".join(errs)
    for field in ("priority", "tags", "hops", "time", "route", "envelope"):
        assert field in joined
    assert validate_envelope({"topic": "@a/b", "priority": True}) != []
    assert validate_envelope({"topic": "@a/b", "message": "x" * 4097}) != []
    assert validate_envelope([]) == ["envelope must be an object"]


def test_parse_priority():
    assert parse_priority("urgent") == 5
    assert parse_priority(" Low ") == 2
    assert parse_priority("4") == 4
    assert parse_priority(3) == 3
    assert parse_priority(None) is None
    assert parse_priority("") is None
    for bad in ("6", "0", "loud", 9):
        with pytest.raises(ValueError):
            parse_priority(bad)


def test_sign_requires_id_and_time():
    k = generate_device_key()
    with pytest.raises(ValueError):
        sign_envelope({"topic": "@a/b"}, k)
    signed = sign_envelope({"topic": "@a/b", "id": ulid(), "time": 1}, k)
    assert verify_envelope(signed)
    assert public_key_from_device_id(signed["sender"]) == k.public_key
    assert not verify_envelope({**signed, "sender": "dev_x"})
    assert not verify_envelope({**signed, "sig": "ed25519:!!"})


def test_encrypt_sign_decrypt_roundtrip():
    key = os.urandom(32)
    k = generate_device_key()
    env = {"topic": "@a/b", "id": ulid(), "time": 1, "title": "t", "message": "m", "sender": k.device_id}
    enc = encrypt_envelope(env, key, "k1")
    assert "title" not in enc and enc["message"] != "m"
    signed = sign_envelope(enc, k)
    assert verify_envelope(signed)
    assert decrypt_envelope(signed, key) == {**env, "sig": signed["sig"]}
    with pytest.raises(ValueError):
        encrypt_envelope(enc, key, "k1")


def test_deduper():
    d = Deduper(capacity=2)
    assert d.accept({"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M"})
    assert not d.accept({"id": "01jd5a2z3k8q9v6x7w4t1r0s2m"})
    assert d.accept({"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2N"})
    assert d.accept({"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2P"})
    assert not d.has("01JD5A2Z3K8Q9V6X7W4T1R0S2M")  # evicted
    assert len(d) == 2
    assert not d.accept({"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2Q", "expires": 10}, now_sec=11)
    assert d.accept({"message": "no id"})
