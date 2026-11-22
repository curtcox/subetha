//! Conformance: checks subetha-core against every file in `spec/vectors`.
//! Byte-for-byte equality with the TypeScript reference is required.

use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};
use subetha_core::canonical::{canonical_envelope, canonicalize, canonicalize_str};
use subetha_core::e2ee::{aad, decrypt_map, encrypt_map};
use subetha_core::encoding::{base45_encode, base64url_decode, base64url_encode, hex_decode, hex_encode};
use subetha_core::edge::{audio, ble, gossip::GossipMessage, qr};
use subetha_core::random::SplitMix64;
use subetha_core::crc::{crc16_ccitt, crc32};
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
    assert_eq!(names, ["canonical.json", "e2ee.json", "edge.json", "signatures.json", "topics.json"], "new vector file: add checks for it");
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

// ---- edge framings (spec §11) ----

#[test]
fn edge_crc_splitmix_base45() {
    let v = load("edge.json");
    let c = &v["crc"];
    let input = c["input"].as_str().unwrap().as_bytes();
    assert_eq!(u64::from(crc16_ccitt(input)), c["crc16_ccitt_false"].as_u64().unwrap());
    assert_eq!(u64::from(crc32(input)), c["crc32"].as_u64().unwrap());
    for s in arr(&v, "splitmix64") {
        let seed: u64 = s["seed"].as_str().unwrap().parse().unwrap();
        let mut r = SplitMix64::new(seed);
        for h in arr(s, "next_u64_hex") {
            assert_eq!(format!("{:016x}", r.next_u64()), h.as_str().unwrap());
        }
        let mut r = SplitMix64::new(seed);
        for f in arr(s, "then_f64_from_fresh") {
            // serde_json's default float parser may be 1 ulp off; the u64 checks above are exact.
            assert!((r.next_f64() - f.as_f64().unwrap()).abs() < 1e-15);
        }
        let b = &s["then_below"];
        for (n, want) in arr(b, "n").iter().zip(arr(b, "values")) {
            assert_eq!(r.below(n.as_u64().unwrap()), want.as_u64().unwrap());
        }
    }
    for c in arr(&v, "base45") {
        let bytes = match c.get("hex") {
            Some(h) => hex_decode(h.as_str().unwrap()).unwrap(),
            None => c["plain"].as_str().unwrap().as_bytes().to_vec(),
        };
        assert_eq!(base45_encode(&bytes), c["encoded"].as_str().unwrap());
    }
}

#[test]
fn edge_audio() {
    let v = load("edge.json");
    let a = &v["audio"];
    assert_eq!(a["sample_rate"].as_u64().unwrap(), u64::from(audio::SAMPLE_RATE));
    assert_eq!(a["symbol_samples"].as_u64().unwrap() as usize, audio::SYMBOL_SAMPLES);
    for c in arr(a, "cases") {
        let p = c["payload"].as_str().unwrap().as_bytes();
        let want: Vec<f32> = arr(c, "tones").iter().map(|t| t.as_f64().unwrap() as f32).collect();
        assert_eq!(audio::tones(p), want);
        assert_eq!(audio::frame_samples(p.len()), c["frame_samples"].as_u64().unwrap() as usize);
    }
    let raw = base64url_decode(a["pcm_s16le"].as_str().unwrap()).unwrap();
    let pcm: Vec<f32> = raw.chunks(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32767.0).collect();
    let payload = a["pcm_payload"].as_str().unwrap().as_bytes();
    assert_eq!(audio::demodulate(&pcm).as_deref(), Some(payload));
    let lead = a["pcm_lead_samples"].as_u64().unwrap() as usize;
    let ours = audio::modulate(payload);
    assert_eq!(ours.len() + lead, pcm.len());
    for (i, x) in ours.iter().enumerate() {
        let q = (x * 32767.0).round() as i32;
        let theirs = i32::from(i16::from_le_bytes([raw[(lead + i) * 2], raw[(lead + i) * 2 + 1]]));
        assert!((q - theirs).abs() <= 2, "sample {i}: {q} vs {theirs}");
    }
}

#[test]
fn edge_fountain() {
    let v = load("edge.json");
    let f = &v["fountain"];
    for c in arr(f, "cdf") {
        let k = c["k"].as_u64().unwrap() as usize;
        let ours = qr::robust_soliton_cdf(k);
        let want = arr(c, "cdf");
        assert_eq!(ours.len(), want.len());
        for (a, b) in ours.iter().zip(want) {
            assert!((a - b.as_f64().unwrap()).abs() < 1e-12, "k={k}");
        }
    }
    for c in arr(f, "frame_blocks") {
        let k = c["k"].as_u64().unwrap() as usize;
        let crc = c["crc"].as_u64().unwrap() as u32;
        let cdf = qr::robust_soliton_cdf(k);
        for s in arr(c, "seqs") {
            let seq = s["seq"].as_u64().unwrap() as u32;
            let want: Vec<usize> = arr(s, "blocks").iter().map(|b| b.as_u64().unwrap() as usize).collect();
            assert_eq!(qr::frame_blocks(seq, k, crc, &cdf), want, "k={k} seq={seq}");
        }
    }
    let payload = f["payload"].as_str().unwrap().as_bytes();
    let enc = qr::encode(payload, f["frame_size"].as_u64().unwrap() as usize).unwrap();
    assert_eq!(enc.source_blocks(), f["source_blocks"].as_u64().unwrap() as usize);
    let mut dec = qr::Decoder::new();
    for fr in arr(f, "frames") {
        let seq = fr["seq"].as_u64().unwrap() as u32;
        assert_eq!(hex_encode(&enc.frame(seq)), fr["hex"].as_str().unwrap(), "frame {seq}");
    }
    for fr in arr(f, "frames").iter().rev() {
        dec.push(&hex_decode(fr["hex"].as_str().unwrap()).unwrap()).unwrap();
    }
    assert_eq!(dec.result(), Some(payload));
}

#[test]
fn edge_ble_and_gossip() {
    let v = load("edge.json");
    let b = &v["ble"];
    let payload = b["payload"].as_str().unwrap().as_bytes();
    let chunks = ble::chunk(b["seq"].as_u64().unwrap() as u16, payload, b["att_mtu"].as_u64().unwrap() as usize).unwrap();
    let want: Vec<String> = arr(b, "chunks").iter().map(|c| c.as_str().unwrap().to_owned()).collect();
    assert_eq!(chunks.iter().map(|c| hex_encode(c)).collect::<Vec<_>>(), want);
    for m in arr(&v, "gossip") {
        let parsed: GossipMessage = serde_json::from_value(m.clone()).unwrap();
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(&back, m);
    }
}
