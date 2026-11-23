//! Wrapped topic keys (spec §5.1): a 32-byte E2EE topic key sealed to one device's identity key.
//!
//! ```text
//! R      = Montgomery u of the recipient's Ed25519 public key
//! epk    = X25519(e, 9);  shared = X25519(e, R)            (all-zero shared is rejected)
//! k      = SHA-256("subetha-wrap-v1\n" || shared || epk || R)
//! ct     = XChaCha20-Poly1305(k, nonce, topic key, aad = canonical(wrapped without "ct"))
//! ```
//! The recipient's X25519 secret is the first 32 bytes of SHA-512(seed). Mirrors
//! `wrapTopicKey` / `unwrapTopicKey` in the TS reference.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use curve25519_dalek::montgomery::MontgomeryPoint;
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::canonical::canonicalize;
use crate::encoding::{base64url_decode, base64url_encode};
use crate::random::random_bytes;
use crate::sign::{public_key_from_device_id, DeviceKey};
use crate::topic::is_topic;
use crate::Error;

pub const WRAP_ALG: &str = "x25519-xchacha20poly1305";
pub const WRAP_DOMAIN: &str = "subetha-wrap-v1\n";

/// A wrapped topic key, as stored by the relay and sent to devices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WrappedKey {
    pub alg: String,
    pub topic: String,
    pub kid: String,
    /// Recipient device id.
    pub to: String,
    /// Ephemeral X25519 public key, base64url.
    pub epk: String,
    pub nonce: String,
    pub ct: String,
}

/// `kid` grammar: 1–64 of `A–Z a–z 0–9 _ . -`.
pub fn is_kid(kid: &str) -> bool {
    !kid.is_empty() && kid.len() <= 64 && kid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// Montgomery u-coordinate of an Ed25519 public key. Fails if it doesn't decompress.
pub fn ed25519_to_x25519_public(pk: &[u8; 32]) -> Result<[u8; 32], Error> {
    let vk = VerifyingKey::from_bytes(pk).map_err(|_| Error::InvalidKey("not a valid ed25519 public key".into()))?;
    Ok(vk.to_montgomery().to_bytes())
}

/// The X25519 secret for a device seed: the first 32 bytes of SHA-512(seed), unclamped.
pub fn x25519_secret_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).to_scalar_bytes()
}

fn x25519(secret: [u8; 32], u: [u8; 32]) -> Result<[u8; 32], Error> {
    let shared = MontgomeryPoint(u).mul_clamped(secret).to_bytes();
    if shared.iter().all(|&b| b == 0) {
        return Err(Error::Encryption("x25519 failed (low-order public key)".into()));
    }
    Ok(shared)
}

fn wrap_key(shared: &[u8; 32], epk: &[u8; 32], rpk: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(WRAP_DOMAIN.as_bytes());
    h.update(shared);
    h.update(epk);
    h.update(rpk);
    h.finalize().into()
}

/// Associated data: the canonical wrapped-key object without `ct`.
pub fn wrap_aad(w: &WrappedKey) -> Result<String, Error> {
    canonicalize(&json!({ "alg": w.alg, "epk": w.epk, "kid": w.kid, "nonce": w.nonce, "to": w.to, "topic": w.topic }))
}

/// Seals `key` for device `to` with fresh random values.
pub fn wrap_topic_key(key: &[u8; 32], topic: &str, kid: &str, to: &str) -> Result<WrappedKey, Error> {
    wrap_topic_key_with(key, topic, kid, to, random_bytes::<32>(), random_bytes::<24>())
}

/// Deterministic form of [`wrap_topic_key`] for test vectors.
pub fn wrap_topic_key_with(key: &[u8; 32], topic: &str, kid: &str, to: &str, ephemeral_secret: [u8; 32], nonce: [u8; 24]) -> Result<WrappedKey, Error> {
    if !is_topic(topic) {
        return Err(Error::Encryption("invalid topic".into()));
    }
    if !is_kid(kid) {
        return Err(Error::Encryption("kid must be 1-64 characters of A-Z a-z 0-9 _ . -".into()));
    }
    let rpk = ed25519_to_x25519_public(&public_key_from_device_id(to)?)?;
    let epk = MontgomeryPoint::mul_base_clamped(ephemeral_secret).to_bytes();
    let k = wrap_key(&x25519(ephemeral_secret, rpk)?, &epk, &rpk);
    let mut w = WrappedKey {
        alg: WRAP_ALG.into(),
        topic: topic.into(),
        kid: kid.into(),
        to: to.into(),
        epk: base64url_encode(&epk),
        nonce: base64url_encode(&nonce),
        ct: String::new(),
    };
    let aad = wrap_aad(&w)?;
    let ct = XChaCha20Poly1305::new((&k).into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: key, aad: aad.as_bytes() })
        .map_err(|_| Error::Encryption("seal failed".into()))?;
    w.ct = base64url_encode(&ct);
    Ok(w)
}

/// Opens a wrapped key with the recipient's device key. `None` if it's malformed, addressed to
/// another device, or was tampered with.
pub fn unwrap_topic_key(w: &WrappedKey, device: &DeviceKey) -> Option<[u8; 32]> {
    if w.alg != WRAP_ALG || !is_topic(&w.topic) || !is_kid(&w.kid) || w.to != device.device_id() {
        return None;
    }
    let rpk = ed25519_to_x25519_public(&device.public_key()).ok()?;
    let epk: [u8; 32] = base64url_decode(&w.epk).ok()?.try_into().ok()?;
    let nonce: [u8; 24] = base64url_decode(&w.nonce).ok()?.try_into().ok()?;
    let ct = base64url_decode(&w.ct).ok()?;
    let k = wrap_key(&x25519(x25519_secret_from_seed(&device.seed()), epk).ok()?, &epk, &rpk);
    let aad = wrap_aad(w).ok()?;
    let key = XChaCha20Poly1305::new((&k).into()).decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: aad.as_bytes() }).ok()?;
    key.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_device() {
        let a = DeviceKey::from_seed(&[1; 32]);
        let b = DeviceKey::from_seed(&[2; 32]);
        let key = [9u8; 32];
        let w = wrap_topic_key(&key, "@alice/secret", "k1", a.device_id()).unwrap();
        assert_eq!(unwrap_topic_key(&w, &a), Some(key));
        assert_eq!(unwrap_topic_key(&w, &b), None);
        let mut forged = w.clone();
        forged.to = b.device_id().into();
        assert_eq!(unwrap_topic_key(&forged, &b), None);
        assert!(wrap_topic_key(&key, "nope", "k1", a.device_id()).is_err());
        assert!(wrap_topic_key(&key, "@alice/secret", "bad kid", a.device_id()).is_err());
    }

    #[test]
    fn secret_matches_converted_public() {
        let d = DeviceKey::from_seed(&[5; 32]);
        let from_secret = MontgomeryPoint::mul_base_clamped(x25519_secret_from_seed(&d.seed())).to_bytes();
        assert_eq!(from_secret, ed25519_to_x25519_public(&d.public_key()).unwrap());
    }
}
