//! Binding-friendly publish-side helpers: strings, byte vectors, bools and simple records
//! only, so the same surface maps cleanly onto UniFFI (Swift/Kotlin, React Native via
//! uniffi-bindgen-react-native) and flutter_rust_bridge. Envelopes cross the boundary as
//! JSON text.
//!
//! With the `uniffi` feature these functions are exported through UniFFI proc-macros
//! (`#[uniffi::export]`); without it they are plain Rust functions. See `BINDINGS.md`.

use serde_json::{Map, Value};

use crate::{canonical, e2ee, envelope, sign, ulid};

/// Error surfaced to foreign languages.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum FfiError {
    #[error("{msg}")]
    Failed { msg: String },
}

impl From<crate::Error> for FfiError {
    fn from(e: crate::Error) -> Self {
        FfiError::Failed { msg: e.to_string() }
    }
}

fn fail(msg: impl Into<String>) -> FfiError {
    FfiError::Failed { msg: msg.into() }
}

/// A freshly generated device key. The seed is secret: store it in the platform keystore.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DeviceKeyRecord {
    pub seed: Vec<u8>,
    pub public_key: Vec<u8>,
    pub device_id: String,
}

fn parse_object(json: &str) -> Result<Map<String, Value>, FfiError> {
    match serde_json::from_str::<Value>(json).map_err(|e| fail(e.to_string()))? {
        Value::Object(m) => Ok(m),
        _ => Err(fail("envelope must be a JSON object")),
    }
}

fn key32(key: &[u8]) -> Result<[u8; 32], FfiError> {
    key.try_into().map_err(|_| fail("key must be 32 bytes"))
}

fn to_json(m: &Map<String, Value>) -> String {
    serde_json::to_string(m).expect("map serializes")
}

/// Generates a new Ed25519 device key.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn new_device_key() -> DeviceKeyRecord {
    record(&sign::DeviceKey::generate())
}

/// Rebuilds the device key record from a stored 32-byte seed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_key_from_seed(seed: Vec<u8>) -> Result<DeviceKeyRecord, FfiError> {
    Ok(record(&sign::DeviceKey::from_seed_slice(&seed)?))
}

fn record(k: &sign::DeviceKey) -> DeviceKeyRecord {
    DeviceKeyRecord { seed: k.seed().to_vec(), public_key: k.public_key().to_vec(), device_id: k.device_id().to_owned() }
}

/// Canonical JSON (spec §3) of any JSON text.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn canonicalize_json(json: String) -> Result<String, FfiError> {
    Ok(canonical::canonicalize_str(&json)?)
}

/// Validation problems for an envelope (empty = valid).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_envelope_json(envelope_json: String) -> Vec<String> {
    match serde_json::from_str::<Value>(&envelope_json) {
        Ok(v) => envelope::validate_envelope(&v),
        Err(e) => vec![format!("json: {e}")],
    }
}

/// A fresh ULID message id.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn new_message_id() -> String {
    ulid::ulid()
}

/// Signs an envelope with the device seed; returns the signed envelope JSON.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sign_envelope_json(envelope_json: String, seed: Vec<u8>) -> Result<String, FfiError> {
    let key = sign::DeviceKey::from_seed_slice(&seed)?;
    Ok(to_json(&sign::sign_map(&parse_object(&envelope_json)?, &key)?))
}

/// Verifies an envelope's signature against its `sender`. Never fails; bad input is `false`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn verify_envelope_json(envelope_json: String) -> bool {
    parse_object(&envelope_json).is_ok_and(|m| sign::verify_map(&m))
}

/// Encrypts an envelope with a 32-byte topic key (random nonce).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn encrypt_envelope_json(envelope_json: String, key: Vec<u8>, kid: String) -> Result<String, FfiError> {
    Ok(to_json(&e2ee::encrypt_map(&parse_object(&envelope_json)?, &key32(&key)?, &kid, None)?))
}

/// Decrypts an envelope; `None` if the key is wrong or the message was tampered with.
/// `sender` and `sig` (outside the AAD) are kept as received.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn decrypt_envelope_json(envelope_json: String, key: Vec<u8>) -> Result<Option<String>, FfiError> {
    let m = parse_object(&envelope_json)?;
    Ok(e2ee::decrypt_map(&m, &key32(&key)?).map(|d| to_json(&d)))
}

/// Raw Ed25519 signature (64 bytes) over `message` with the device seed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sign_bytes(seed: Vec<u8>, message: Vec<u8>) -> Result<Vec<u8>, FfiError> {
    Ok(sign::DeviceKey::from_seed_slice(&seed)?.sign_bytes(&message).to_vec())
}

/// Header values for a device-signed HTTP request (`X-Device-Id`, `X-Device-Time`,
/// `X-Device-Signature`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignedRequestRecord {
    pub device_id: String,
    pub time: u64,
    pub signature: String,
}

/// The string a device signs for an HTTP request:
/// `subetha-req-v1\n METHOD \n path?query \n time \n hex(sha256(body))` (no spaces).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn request_signing_input(method: String, path_and_query: String, time: u64, body: Vec<u8>) -> String {
    use sha2::Digest;
    let digest = crate::encoding::hex_encode(&sha2::Sha256::digest(&body));
    format!("subetha-req-v1\n{}\n{path_and_query}\n{time}\n{digest}", method.to_uppercase())
}

/// Signs an HTTP request. `path_and_query` is the URL path plus `?query` if any (no host).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sign_request(seed: Vec<u8>, method: String, path_and_query: String, time: u64, body: Vec<u8>) -> Result<SignedRequestRecord, FfiError> {
    let key = sign::DeviceKey::from_seed_slice(&seed)?;
    let input = request_signing_input(method, path_and_query, time, body);
    let signature = crate::encoding::base64url_encode(&key.sign_bytes(input.as_bytes()));
    Ok(SignedRequestRecord { device_id: key.device_id().to_owned(), time, signature })
}

/// Proof of key possession for `POST /v1/device/code`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EnrollmentProofRecord {
    pub device_id: String,
    pub time: u64,
    pub proof: String,
}

/// Signs `subetha-enroll-v1\n<device_id>\n<time>`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn enrollment_proof(seed: Vec<u8>, time: u64) -> Result<EnrollmentProofRecord, FfiError> {
    let key = sign::DeviceKey::from_seed_slice(&seed)?;
    let input = format!("subetha-enroll-v1\n{}\n{time}", key.device_id());
    let proof = crate::encoding::base64url_encode(&key.sign_bytes(input.as_bytes()));
    Ok(EnrollmentProofRecord { device_id: key.device_id().to_owned(), time, proof })
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8032 test 1 seed (also spec/vectors/signatures.json devices[0]).
    const SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

    #[test]
    fn request_signing() {
        let seed = crate::encoding::hex_decode(SEED).unwrap();
        let input = request_signing_input("post".into(), "/v1/ack?x=1".into(), 1763750000, b"{}".to_vec());
        assert_eq!(input, "subetha-req-v1\nPOST\n/v1/ack?x=1\n1763750000\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
        let r = sign_request(seed.clone(), "POST".into(), "/v1/ack?x=1".into(), 1763750000, b"{}".to_vec()).unwrap();
        assert_eq!(r.device_id, "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena");
        let sig = crate::encoding::base64url_decode(&r.signature).unwrap();
        assert_eq!(sig, sign_bytes(seed.clone(), input.into_bytes()).unwrap());
        // Pinned so the Kotlin/Swift/Dart SDK tests can check their signers against the core.
        assert_eq!(r.signature, REQ_SIG);
        let p = enrollment_proof(seed, 1763750000).unwrap();
        assert_eq!(p.proof, ENROLL_SIG);
        assert!(sign_bytes(vec![0; 3], vec![]).is_err());
    }

    const REQ_SIG: &str = "aMS_4A8mZWICmhOQb6w5LxhZ8xXpltw-dtFLPWGWTaGQTZm9PIcwEAUs88n30exIwuAjedPlr2-C20WQadlqBQ";
    const ENROLL_SIG: &str = "ZTDaaJXLPfCowo3I7bl8k3JvIl5nYldqr4735NNFrw4bGcu-Tl2p2W7jYXZH8NuORBcsaVO-5Em3aahKD1eqDQ";

    #[test]
    fn publish_flow() {
        let k = new_device_key();
        assert_eq!(device_key_from_seed(k.seed.clone()).unwrap(), k);
        assert!(device_key_from_seed(vec![1, 2]).is_err());
        let env = format!(r#"{{"id":"{}","time":1763750000,"topic":"@a/b","title":"t","message":"hi"}}"#, new_message_id());
        assert!(validate_envelope_json(env.clone()).is_empty());
        let topic_key = e2ee::generate_topic_key().to_vec();
        let enc = encrypt_envelope_json(env.clone(), topic_key.clone(), "k1".into()).unwrap();
        let signed = sign_envelope_json(enc, k.seed.clone()).unwrap();
        assert!(verify_envelope_json(signed.clone()));
        assert!(validate_envelope_json(signed.clone()).is_empty());
        let dec: Value = serde_json::from_str(&decrypt_envelope_json(signed, topic_key).unwrap().unwrap()).unwrap();
        assert_eq!(dec["message"], "hi");
        assert_eq!(dec["sender"], Value::String(k.device_id));
    }

    #[test]
    fn errors() {
        assert!(canonicalize_json("{\"a\":1.5}".into()).is_err());
        assert_eq!(canonicalize_json("{\"b\":1,\"a\":2}".into()).unwrap(), r#"{"a":2,"b":1}"#);
        assert!(!verify_envelope_json("not json".into()));
        assert!(sign_envelope_json("[]".into(), vec![0; 32]).is_err());
        assert!(encrypt_envelope_json("{}".into(), vec![0; 31], "k".into()).is_err());
        assert_eq!(validate_envelope_json("{".into()).len(), 1);
        let enc = encrypt_envelope_json(r#"{"topic":"@a/b","message":"x"}"#.into(), vec![1; 32], "k".into()).unwrap();
        assert_eq!(decrypt_envelope_json(enc, vec![2; 32]).unwrap(), None);
    }
}
