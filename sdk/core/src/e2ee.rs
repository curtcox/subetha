//! Optional end-to-end encryption (spec §5), XChaCha20-Poly1305.
//!
//! 1. Move the protected fields that are present (`title`, `message`, `attachment`, `click`,
//!    `actions`, `content_type`) into a canonical JSON object `P`.
//! 2. Drop any stale `sig`, set `enc = {alg, kid, nonce}`.
//! 3. `ct = XChaCha20-Poly1305(key, nonce, P, aad = canonical(envelope without message))`.
//! 4. `message = base64url(ct)`.
//!
//! Mirrors `encryptEnvelope` / `decryptEnvelope` in the TS reference.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::{json, Map, Value};

use crate::canonical::{canonical_envelope, canonicalize};
use crate::encoding::{base64url_decode, base64url_encode};
use crate::envelope::Envelope;
use crate::random::random_bytes;
use crate::Error;

pub const ALG: &str = "xchacha20poly1305";
pub const PROTECTED_FIELDS: [&str; 6] = ["title", "message", "attachment", "click", "actions", "content_type"];

/// A fresh random 32-byte topic key.
pub fn generate_topic_key() -> [u8; 32] {
    random_bytes::<32>()
}

/// Raw AEAD seal: returns `ciphertext || tag`.
pub fn xchacha_seal(key: &[u8; 32], nonce: &[u8; 24], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .map_err(|_| Error::Encryption("seal failed".into()))
}

/// Raw AEAD open. `None` if authentication fails.
pub fn xchacha_open(key: &[u8; 32], nonce: &[u8; 24], sealed: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
    XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad }).ok()
}

/// Encrypts an envelope object. `nonce` should be `None` (random) except in tests.
pub fn encrypt_map(env: &Map<String, Value>, key: &[u8; 32], kid: &str, nonce: Option<[u8; 24]>) -> Result<Map<String, Value>, Error> {
    if env.get("enc").is_some_and(|v| !v.is_null()) {
        return Err(Error::Encryption("already encrypted".into()));
    }
    let nonce = nonce.unwrap_or_else(random_bytes::<24>);
    let mut out = env.clone();
    let mut prot = Map::new();
    for f in PROTECTED_FIELDS {
        if let Some(v) = out.remove(f) {
            prot.insert(f.to_owned(), v);
        }
    }
    out.remove("sig");
    out.insert("enc".into(), json!({"alg": ALG, "kid": kid, "nonce": base64url_encode(&nonce)}));
    let aad = canonical_envelope(&out)?;
    let pt = canonicalize(&Value::Object(prot))?;
    let ct = xchacha_seal(key, &nonce, pt.as_bytes(), aad.as_bytes())?;
    out.insert("message".into(), Value::String(base64url_encode(&ct)));
    Ok(out)
}

/// Decrypts an envelope object. `None` if it isn't encrypted, the key is wrong, or it was
/// tampered with.
///
/// Note (spec gap, reported): the AAD is the canonical envelope minus `message`, `sig` and
/// `hops`, so a `sender` added by signing *after* encryption changes the AAD and decryption
/// of a signed encrypted envelope fails unless the sender was set before encrypting. This
/// function follows the spec and the TS reference exactly; see [`decrypt_signed_map`].
pub fn decrypt_map(env: &Map<String, Value>, key: &[u8; 32]) -> Option<Map<String, Value>> {
    let enc = env.get("enc")?.as_object()?;
    let message = env.get("message")?.as_str()?;
    if enc.get("alg").and_then(Value::as_str) != Some(ALG) {
        return None;
    }
    let nonce: [u8; 24] = base64url_decode(enc.get("nonce")?.as_str()?).ok()?.try_into().ok()?;
    let mut rest = env.clone();
    rest.remove("message");
    let aad = canonical_envelope(&rest).ok()?;
    let pt = xchacha_open(key, &nonce, &base64url_decode(message).ok()?, aad.as_bytes())?;
    let prot: Value = serde_json::from_slice(&pt).ok()?;
    let mut out = rest;
    for (k, v) in prot.as_object()? {
        out.insert(k.clone(), v.clone());
    }
    out.remove("enc");
    Some(out)
}

/// Decrypts an envelope that was encrypted and then signed: tries the spec AAD first, then
/// the AAD without the `sender` that signing added. The result keeps `sender` and `sig`
/// (the signature still covers the ciphertext form, not the decrypted one).
pub fn decrypt_signed_map(env: &Map<String, Value>, key: &[u8; 32]) -> Option<Map<String, Value>> {
    if let Some(m) = decrypt_map(env, key) {
        return Some(m);
    }
    let mut stripped = env.clone();
    let sender = stripped.remove("sender")?;
    let sig = stripped.remove("sig");
    let mut out = decrypt_map(&stripped, key)?;
    out.insert("sender".into(), sender);
    if let Some(s) = sig {
        out.insert("sig".into(), s);
    }
    Some(out)
}

/// Typed wrapper for [`encrypt_map`].
pub fn encrypt_envelope(env: &Envelope, key: &[u8; 32], kid: &str) -> Result<Envelope, Error> {
    Envelope::from_map(encrypt_map(&env.to_map(), key, kid, None)?)
}

/// Typed wrapper for [`decrypt_map`].
pub fn decrypt_envelope(env: &Envelope, key: &[u8; 32]) -> Option<Envelope> {
    Envelope::from_map(decrypt_map(&env.to_map(), key)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sign::{sign_map, verify_map, DeviceKey};

    fn plain() -> Map<String, Value> {
        json!({"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2Q", "time": 5, "topic": "@a/b", "title": "T", "message": "secret",
               "priority": 4, "hops": 2, "x_new": [1]})
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn roundtrip_and_tamper() {
        let key = generate_topic_key();
        let enc = encrypt_map(&plain(), &key, "k1", None).unwrap();
        assert!(enc.get("title").is_none());
        assert_eq!(enc["hops"], json!(2));
        assert_eq!(decrypt_map(&enc, &key).unwrap(), plain());
        // Hops are outside the AAD; edge relays may change them.
        let mut h = enc.clone();
        h.insert("hops".into(), json!(0));
        assert!(decrypt_map(&h, &key).is_some());
        // Wrong key, tampered AAD field, tampered ciphertext.
        assert!(decrypt_map(&enc, &generate_topic_key()).is_none());
        let mut t = enc.clone();
        t.insert("priority".into(), json!(5));
        assert!(decrypt_map(&t, &key).is_none());
        let mut t = enc.clone();
        t.insert("message".into(), json!("AAAA"));
        assert!(decrypt_map(&t, &key).is_none());
        assert!(encrypt_map(&enc, &key, "k1", None).is_err());
        assert!(decrypt_map(&plain(), &key).is_none());
    }

    #[test]
    fn random_nonces_differ() {
        let key = generate_topic_key();
        let a = encrypt_map(&plain(), &key, "k", None).unwrap();
        let b = encrypt_map(&plain(), &key, "k", None).unwrap();
        assert_ne!(a["message"], b["message"]);
    }

    #[test]
    fn encrypt_then_sign() {
        let key = generate_topic_key();
        let dk = DeviceKey::generate();
        let signed = sign_map(&encrypt_map(&plain(), &key, "k", None).unwrap(), &dk).unwrap();
        assert!(verify_map(&signed));
        // Spec-exact decryption fails because `sender` joined the AAD after encryption ...
        assert!(decrypt_map(&signed, &key).is_none());
        // ... the tolerant helper recovers it.
        let d = decrypt_signed_map(&signed, &key).unwrap();
        assert_eq!(d["message"], json!("secret"));
        assert_eq!(d["sender"], json!(dk.device_id()));
        // Setting sender *before* encrypting makes the spec path work.
        let mut p = plain();
        p.insert("sender".into(), json!(dk.device_id()));
        let signed = sign_map(&encrypt_map(&p, &key, "k", None).unwrap(), &dk).unwrap();
        assert!(verify_map(&signed));
        assert!(decrypt_map(&signed, &key).is_some());
    }

    #[test]
    fn typed() {
        let key = generate_topic_key();
        let e = Envelope::new("@a/b", "hi").with_id_and_time();
        let c = encrypt_envelope(&e, &key, "k").unwrap();
        assert!(c.validate().is_empty(), "{:?}", c.validate());
        assert_eq!(decrypt_envelope(&c, &key).unwrap(), e);
    }
}
