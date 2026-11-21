//! Device identity (spec §1.3) and envelope signatures (spec §4).
//!
//! ```text
//! sig = "ed25519:" + base64url_nopad(Ed25519_sign(sk, "subetha-sig-v1\n" || canonical(envelope)))
//! ```
//! `canonical` drops `sig` and `hops`, so edge relays can decrement `hops` without breaking
//! the signature. The verifier recovers the public key from `sender` (`dev_` + base32(pk)).

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::{Map, Value};

use crate::canonical::canonical_envelope;
use crate::encoding::{base32_decode, base32_encode, base64url_decode, base64url_encode};
use crate::envelope::Envelope;
use crate::random::random_bytes;
use crate::Error;

/// Domain separation prefix for signatures.
pub const SIG_DOMAIN: &str = "subetha-sig-v1\n";
pub const SIG_PREFIX: &str = "ed25519:";

/// An Ed25519 device key.
#[derive(Clone)]
pub struct DeviceKey {
    signing: SigningKey,
    device_id: String,
}

impl std::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKey").field("device_id", &self.device_id).finish_non_exhaustive()
    }
}

impl DeviceKey {
    /// Derives a key from a 32-byte seed (RFC 8032 private key).
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(seed);
        let device_id = device_id_from_public_key(signing.verifying_key().as_bytes());
        DeviceKey { signing, device_id }
    }

    /// Like [`from_seed`](Self::from_seed) but checks the length.
    pub fn from_seed_slice(seed: &[u8]) -> Result<Self, Error> {
        let seed: [u8; 32] = seed.try_into().map_err(|_| Error::InvalidKey("seed must be 32 bytes".into()))?;
        Ok(Self::from_seed(&seed))
    }

    /// A new random key from the OS CSPRNG.
    pub fn generate() -> Self {
        Self::from_seed(&random_bytes::<32>())
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    /// The 32-byte seed. Keep it secret.
    pub fn seed(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    /// Raw Ed25519 signature over `msg`.
    pub fn sign_bytes(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }
}

/// `dev_` + lowercase base32 (no padding) of the 32-byte public key.
pub fn device_id_from_public_key(pk: &[u8; 32]) -> String {
    format!("dev_{}", base32_encode(pk))
}

/// Syntactic check: `dev_[a-z2-7]{52}`.
pub fn is_device_id(s: &str) -> bool {
    s.len() == 56 && s.starts_with("dev_") && s.as_bytes()[4..].iter().all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(c))
}

/// Recovers the public key from a device id.
///
/// Stricter than the TS reference: the id must be the *canonical* encoding (the 4 unused
/// trailing bits of the last base32 character must be zero), so one key has exactly one id.
pub fn public_key_from_device_id(id: &str) -> Result<[u8; 32], Error> {
    if !is_device_id(id) {
        return Err(Error::InvalidDeviceId);
    }
    let pk: [u8; 32] = base32_decode(&id[4..])?.try_into().map_err(|_| Error::InvalidDeviceId)?;
    if device_id_from_public_key(&pk) != id {
        return Err(Error::InvalidDeviceId);
    }
    Ok(pk)
}

/// The exact bytes that are signed: `"subetha-sig-v1\n" || canonical(envelope)`.
pub fn signing_input(env: &Map<String, Value>) -> Result<Vec<u8>, Error> {
    Ok(format!("{SIG_DOMAIN}{}", canonical_envelope(env)?).into_bytes())
}

/// Returns a copy of the envelope object with `sender` and `sig` set.
/// The envelope must carry a string `id` and a numeric `time` (spec §2).
pub fn sign_map(env: &Map<String, Value>, key: &DeviceKey) -> Result<Map<String, Value>, Error> {
    if !env.get("id").is_some_and(Value::is_string) || !env.get("time").is_some_and(Value::is_number) {
        return Err(Error::Signing("signed messages must carry id and time".into()));
    }
    let mut out = env.clone();
    out.remove("sig");
    out.insert("sender".into(), Value::String(key.device_id().to_owned()));
    let sig = key.sign_bytes(&signing_input(&out)?);
    out.insert("sig".into(), Value::String(format!("{SIG_PREFIX}{}", base64url_encode(&sig))));
    Ok(out)
}

/// Verifies `sig` against the public key embedded in `sender`. Never panics.
pub fn verify_map(env: &Map<String, Value>) -> bool {
    let (Some(sig), Some(sender)) = (env.get("sig").and_then(Value::as_str), env.get("sender").and_then(Value::as_str)) else {
        return false;
    };
    let Some(sig_b64) = sig.strip_prefix(SIG_PREFIX) else { return false };
    let Ok(pk) = public_key_from_device_id(sender) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    let Ok(sig_bytes) = base64url_decode(sig_b64) else { return false };
    let Ok(sig_bytes) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else { return false };
    let Ok(msg) = signing_input(env) else { return false };
    vk.verify_strict(&msg, &Signature::from_bytes(&sig_bytes)).is_ok()
}

/// Signs a typed envelope. See [`sign_map`].
pub fn sign_envelope(env: &Envelope, key: &DeviceKey) -> Result<Envelope, Error> {
    Envelope::from_map(sign_map(&env.to_map(), key)?)
}

/// Verifies a typed envelope. See [`verify_map`].
pub fn verify_envelope(env: &Envelope) -> bool {
    verify_map(&env.to_map())
}

/// Verifies a JSON value (must be an object).
pub fn verify_value(env: &Value) -> bool {
    env.as_object().is_some_and(verify_map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn rfc8032_test1_device_id() {
        let seed: [u8; 32] = crate::encoding::hex_decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap()
            .try_into()
            .unwrap();
        let k = DeviceKey::from_seed(&seed);
        assert_eq!(crate::encoding::hex_encode(&k.public_key()), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        assert_eq!(k.device_id(), "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena");
        assert_eq!(public_key_from_device_id(k.device_id()).unwrap(), k.public_key());
        assert_eq!(k.seed(), seed);
    }

    #[test]
    fn sign_verify_roundtrip_and_hops() {
        let k = DeviceKey::generate();
        let env = obj(json!({"id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "time": 1, "topic": "@a/b", "message": "m", "hops": 3}));
        let mut signed = sign_map(&env, &k).unwrap();
        assert!(verify_map(&signed));
        signed.insert("hops".into(), json!(0));
        assert!(verify_map(&signed));
        signed.insert("message".into(), json!("n"));
        assert!(!verify_map(&signed));
    }

    #[test]
    fn requires_id_and_time() {
        let k = DeviceKey::generate();
        assert!(sign_map(&obj(json!({"topic": "@a/b"})), &k).is_err());
        assert!(sign_map(&obj(json!({"topic": "@a/b", "id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M"})), &k).is_err());
    }

    #[test]
    fn non_canonical_device_id_rejected() {
        let k = DeviceKey::generate();
        let id = k.device_id();
        // The last char carries 1 data bit + 4 zero bits; flipping a padding bit aliases the key.
        const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
        let idx = B32.iter().position(|&c| c == id.as_bytes()[55]).unwrap();
        let aliased = format!("{}{}", &id[..55], B32[idx ^ 1] as char);
        assert_ne!(aliased, id);
        assert!(is_device_id(&aliased));
        // Same 32 decoded bytes, but not the canonical id.
        assert_eq!(base32_decode(&aliased[4..]).unwrap(), k.public_key());
        assert!(public_key_from_device_id(&aliased).is_err());
    }

    #[test]
    fn typed_wrappers() {
        let k = DeviceKey::generate();
        let e = Envelope::new("@a/b", "hello").with_id_and_time();
        let s = sign_envelope(&e, &k).unwrap();
        assert_eq!(s.sender.as_deref(), Some(k.device_id()));
        assert!(verify_envelope(&s));
        assert!(verify_value(&s.to_value()));
        assert!(!verify_envelope(&e));
    }
}
