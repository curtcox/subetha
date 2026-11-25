//! Binding-friendly publish-side helpers: strings, byte vectors, bools and simple records
//! only, so the same surface maps cleanly onto UniFFI (Swift/Kotlin, React Native via
//! uniffi-bindgen-react-native) and flutter_rust_bridge. Envelopes cross the boundary as
//! JSON text.
//!
//! With the `uniffi` feature these functions are exported through UniFFI proc-macros
//! (`#[uniffi::export]`); without it they are plain Rust functions. See `BINDINGS.md`.

use serde_json::{Map, Value};

use crate::{canonical, e2ee, envelope, keywrap, request, sign, ulid};

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

/// Wraps a 32-byte topic key for device `to` (spec §5.1); returns the wrapped-key JSON for
/// `PUT /v1/keys`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn wrap_topic_key_json(key: Vec<u8>, topic: String, kid: String, to: String) -> Result<String, FfiError> {
    let w = keywrap::wrap_topic_key(&key32(&key)?, &topic, &kid, &to)?;
    Ok(serde_json::to_string(&w).expect("wrapped key serializes"))
}

/// Opens a wrapped key (one entry of `GET /v1/keys`; `created_at` is ignored) with the device
/// seed. `None` if it isn't for this device, isn't a wrapped key, or was tampered with.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn unwrap_topic_key_json(wrapped_json: String, seed: Vec<u8>) -> Result<Option<Vec<u8>>, FfiError> {
    let key = sign::DeviceKey::from_seed_slice(&seed)?;
    let mut m = parse_object(&wrapped_json)?;
    m.remove("created_at");
    let Ok(w) = serde_json::from_value::<keywrap::WrappedKey>(Value::Object(m)) else { return Ok(None) };
    Ok(keywrap::unwrap_topic_key(&w, &key).map(|k| k.to_vec()))
}

/// Raw Ed25519 signature (64 bytes) over `message` with the device seed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sign_bytes(seed: Vec<u8>, message: Vec<u8>) -> Result<Vec<u8>, FfiError> {
    Ok(sign::DeviceKey::from_seed_slice(&seed)?.sign_bytes(&message).to_vec())
}

/// Header values for a device-signed HTTP request (spec §8.1): `X-Device-Id`, `X-Device-Time`,
/// `X-Device-Nonce`, `X-Device-Signed-Headers`, `X-Device-Signature`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignedRequestRecord {
    pub device_id: String,
    pub time: u64,
    pub nonce: String,
    pub signed_headers: String,
    pub signature: String,
}

/// One HTTP header (name and value).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct HeaderRecord {
    pub name: String,
    pub value: String,
}

fn pairs(headers: Vec<HeaderRecord>) -> Vec<(String, String)> {
    headers.into_iter().map(|h| (h.name, h.value)).collect()
}

/// A fresh single-use request nonce: base64url of 16 random bytes (22 chars).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn new_request_nonce() -> String {
    crate::encoding::base64url_encode(&crate::random::random_bytes::<16>())
}

/// The string a device signs for an HTTP request (spec §8.1, `subetha-req-v2`):
/// `subetha-req-v2\nMETHOD\nhost\npath?query\nhex(sha256(body))`, then `\nname:value` for each
/// of `signed_headers`, in order. `host` is what WHATWG `URL.host` gives: lowercase, with
/// `:port` only when the port is not the scheme's default.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn request_signing_input(method: String, host: String, path_and_query: String, body: Vec<u8>, signed_headers: Vec<HeaderRecord>) -> String {
    request::signing_input_v2(&method, &host, &path_and_query, &body, &pairs(signed_headers))
}

/// Signs an HTTP request. `path_and_query` is the URL path plus `?query` if any. `headers` are
/// the headers the request will carry (content and routing headers must be signed;
/// Authorization, User-Agent and the like are skipped). `nonce` `None` draws a fresh one ([`new_request_nonce`]); relays
/// accept each nonce once.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[allow(clippy::too_many_arguments)]
pub fn sign_request(
    seed: Vec<u8>,
    method: String,
    host: String,
    path_and_query: String,
    time: u64,
    nonce: Option<String>,
    body: Vec<u8>,
    headers: Vec<HeaderRecord>,
) -> Result<SignedRequestRecord, FfiError> {
    let key = sign::DeviceKey::from_seed_slice(&seed)?;
    let nonce = nonce.unwrap_or_else(new_request_nonce);
    let r = request::sign_request(&key, &method, &host, &path_and_query, time, &nonce, &body, &pairs(headers))?;
    Ok(SignedRequestRecord { device_id: r.device_id, time: r.time, nonce: r.nonce, signed_headers: r.signed_headers, signature: r.signature })
}

/// Proof of key possession for `POST /v1/devices/dba`.
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
        let h = |n: &str, v: &str| HeaderRecord { name: n.into(), value: v.into() };
        let headers = vec![h("X-Title", "Door"), h("Authorization", "Bearer x"), h("content-type", "text/plain")];
        let r = sign_request(seed.clone(), "post".into(), "x.test".into(), "/v1/ack?x=1".into(), 1763750000, Some(NONCE.into()), b"{}".to_vec(), headers).unwrap();
        assert_eq!(r.device_id, "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena");
        assert_eq!(r.nonce, NONCE);
        assert_eq!(r.signed_headers, "x-device-id,x-device-time,x-device-nonce,content-type,x-title");
        let signed = vec![h("x-device-id", &r.device_id), h("x-device-time", "1763750000"), h("x-device-nonce", NONCE), h("content-type", "text/plain"), h("x-title", "Door")];
        let input = request_signing_input("POST".into(), "x.test".into(), "/v1/ack?x=1".into(), b"{}".to_vec(), signed);
        assert_eq!(
            input,
            format!("subetha-req-v2\nPOST\nx.test\n/v1/ack?x=1\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\nx-device-id:{}\nx-device-time:1763750000\nx-device-nonce:{NONCE}\ncontent-type:text/plain\nx-title:Door", r.device_id)
        );
        let sig = crate::encoding::base64url_decode(&r.signature).unwrap();
        assert_eq!(sig, sign_bytes(seed.clone(), input.into_bytes()).unwrap());
        // Fresh nonces are 22 base64url chars and differ per request.
        let a = sign_request(seed.clone(), "GET".into(), "x.test".into(), "/".into(), 1, None, vec![], vec![]).unwrap();
        let b = sign_request(seed.clone(), "GET".into(), "x.test".into(), "/".into(), 1, None, vec![], vec![]).unwrap();
        assert_eq!(a.nonce.len(), 22);
        assert_ne!(a.nonce, b.nonce);
        assert!(sign_request(seed.clone(), "GET".into(), "x.test".into(), "/".into(), 1, Some("short".into()), vec![], vec![]).is_err());
        assert!(sign_request(seed.clone(), "GET".into(), "x.test".into(), "/".into(), 1, Some("not base64url!!!!!!!".into()), vec![], vec![]).is_err());
        let p = enrollment_proof(seed, 1763750000).unwrap();
        assert_eq!(p.proof, ENROLL_SIG);
        assert!(sign_bytes(vec![0; 3], vec![]).is_err());
    }

    #[test]
    fn topic_key_wrapping() {
        let seed = crate::encoding::hex_decode(SEED).unwrap();
        let me = device_key_from_seed(seed.clone()).unwrap();
        let w = wrap_topic_key_json(vec![7; 32], "@alice/secret".into(), "k1".into(), me.device_id.clone()).unwrap();
        assert_eq!(unwrap_topic_key_json(w.clone(), seed.clone()).unwrap(), Some(vec![7; 32]));
        // As served by GET /v1/keys, with created_at.
        let mut listed: Value = serde_json::from_str(&w).unwrap();
        listed["created_at"] = 1.into();
        assert_eq!(unwrap_topic_key_json(listed.to_string(), seed.clone()).unwrap(), Some(vec![7; 32]));
        assert_eq!(unwrap_topic_key_json(w.clone(), vec![1; 32]).unwrap(), None);
        assert_eq!(unwrap_topic_key_json(r#"{"alg":"x"}"#.into(), seed.clone()).unwrap(), None);
        assert!(unwrap_topic_key_json("[]".into(), seed).is_err());
        assert!(wrap_topic_key_json(vec![7; 31], "@alice/secret".into(), "k1".into(), me.device_id).is_err());
    }

    const NONCE: &str = "nonce_0123456789abcdef";
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
