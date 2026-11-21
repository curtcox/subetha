//! Conformance: checks subetha-core against every file in `spec/vectors`.
//! Byte-for-byte equality with the TypeScript reference is required.

use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};
use subetha_core::canonical::{canonical_envelope, canonicalize, canonicalize_str};
use subetha_core::e2ee::{aad, decrypt_map, encrypt_map};
use subetha_core::encoding::{base64url_encode, hex_decode, hex_encode};
use subetha_core::envelope::validate_envelope;
use subetha_core::sign::{sign_map, signing_input, verify_map, DeviceKey};
use subetha_core::topic::is_topic;
use subetha_core::Envelope;

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors")
}

fn load(name: &str) -> Value {
    let path = vectors_dir().join(name);
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn obj(v: &Value) -> &Map<String, Value> {
    v.as_object().expect("object")
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a Vec<Value> {
    v[k].as_array().unwrap_or_else(|| panic!("{k} must be an array"))
}

fn seed(v: &Value) -> [u8; 32] {
    hex_decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
}

#[test]
fn every_vector_file_is_covered() {
    let mut names: Vec<String> = fs::read_dir(vectors_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert_eq!(names, ["canonical.json", "e2ee.json", "signatures.json", "topics.json"], "new vector file: add checks for it");
}

#[test]
fn canonical_vectors() {
    let v = load("canonical.json");
    for c in arr(&v, "valid") {
        let name = c["name"].as_str().unwrap();
        assert_eq!(canonicalize(&c["input"]).unwrap(), c["canonical"].as_str().unwrap(), "{name}");
    }
    for c in arr(&v, "invalid") {
        let name = c["name"].as_str().unwrap();
        assert!(canonicalize_str(c["input_json"].as_str().unwrap()).is_err(), "must reject {name}");
    }
}

#[test]
fn topic_vectors() {
    let v = load("topics.json");
    for t in arr(&v, "valid") {
        assert!(is_topic(t.as_str().unwrap()), "{t}");
    }
    for t in arr(&v, "invalid") {
        assert!(!is_topic(t.as_str().unwrap()), "{t}");
    }
}

#[test]
fn device_id_vectors() {
    let v = load("signatures.json");
    for d in arr(&v, "devices") {
        let k = DeviceKey::from_seed(&seed(&d["seed"]));
        assert_eq!(hex_encode(&k.public_key()), d["public_key"].as_str().unwrap());
        assert_eq!(k.device_id(), d["device_id"].as_str().unwrap());
    }
}

#[test]
fn signature_cases() {
    let v = load("signatures.json");
    for c in arr(&v, "cases") {
        let k = DeviceKey::from_seed(&seed(&c["seed"]));
        let signed = sign_map(obj(&c["unsigned"]), &k).unwrap();
        assert_eq!(Value::Object(signed.clone()), c["signed"], "signed envelope must match exactly");
        assert_eq!(canonical_envelope(&signed).unwrap(), c["canonical"].as_str().unwrap());
        assert_eq!(signing_input(&signed).unwrap(), c["signing_input"].as_str().unwrap().as_bytes());
        assert!(verify_map(obj(&c["signed"])));
        assert_eq!(validate_envelope(&c["signed"]), Vec::<String>::new());
        // The typed envelope round-trips without losing unknown fields.
        let typed = Envelope::from_value(c["signed"].clone()).unwrap();
        assert_eq!(typed.to_value(), c["signed"]);
        assert!(subetha_core::verify_envelope(&typed));
    }
}

#[test]
fn hops_change_still_verifies() {
    let v = load("signatures.json");
    let h = &v["hops_change"];
    assert_eq!(verify_map(obj(&h["envelope"])), h["valid"].as_bool().unwrap());
    let e = &v["event_added"];
    assert_eq!(verify_map(obj(&e["envelope"])), e["valid"].as_bool().unwrap());
}

#[test]
fn negative_signatures_fail() {
    let v = load("signatures.json");
    for n in arr(&v, "negative") {
        assert!(!verify_map(obj(&n["envelope"])), "{} must fail", n["name"]);
    }
    // Spec §1.3: non-canonical device ids are rejected outright.
    let nc = arr(&v, "negative")
        .iter()
        .find(|n| n["name"].as_str().unwrap().starts_with("non-canonical sender"))
        .expect("non-canonical sender vector");
    let sender = nc["envelope"]["sender"].as_str().unwrap();
    assert!(subetha_core::sign::is_device_id(sender));
    assert!(subetha_core::sign::public_key_from_device_id(sender).is_err());
}

#[test]
fn e2ee_vectors() {
    let v = load("e2ee.json");
    let key = seed(&v["key"]);
    let nonce: [u8; 24] = hex_decode(v["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
    assert_eq!(base64url_encode(&nonce), v["nonce_b64"].as_str().unwrap());
    let kid = v["kid"].as_str().unwrap();

    let enc = encrypt_map(obj(&v["plaintext"]), &key, kid, Some(nonce)).unwrap();
    assert_eq!(Value::Object(enc.clone()), v["encrypted"], "ciphertext must match exactly");
    assert_eq!(aad(&enc).unwrap(), v["aad"].as_str().unwrap());

    let dec = decrypt_map(obj(&v["encrypted"]), &key).unwrap();
    assert_eq!(Value::Object(dec), v["plaintext"]);

    let es = &v["encrypted_signed"];
    assert!(verify_map(obj(es)));
    assert_eq!(validate_envelope(es), Vec::<String>::new());
    // encrypted_signed is `encrypted` signed with signatures.devices[0].
    let sigs = load("signatures.json");
    let k0 = DeviceKey::from_seed(&seed(&sigs["devices"][0]["seed"]));
    assert_eq!(Value::Object(sign_map(obj(&v["encrypted"]), &k0).unwrap()), *es);
    // The AAD excludes sender and sig, so the signed form has the same AAD and decrypts.
    assert_eq!(aad(obj(es)).unwrap(), v["aad"].as_str().unwrap());
}

#[test]
fn e2ee_decrypted_signed() {
    let v = load("e2ee.json");
    let key = seed(&v["key"]);
    let dec = decrypt_map(obj(&v["encrypted_signed"]), &key).expect("encrypted_signed must decrypt");
    assert_eq!(Value::Object(dec.clone()), v["decrypted_signed"]);
    // sender and sig are kept as received.
    assert_eq!(dec["sender"], v["encrypted_signed"]["sender"]);
    assert_eq!(dec["sig"], v["encrypted_signed"]["sig"]);
    assert!(dec.get("enc").is_none());
}
