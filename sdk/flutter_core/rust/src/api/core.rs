//! Envelope, key, and request functions from `subetha_core::ffi`, for Dart. The same
//! string/bytes surface the UniFFI bindings (Kotlin, Swift) use. All of them are fast, so they
//! are synchronous in Dart.

use flutter_rust_bridge::frb;
use subetha_core::ffi as core;

/// Runs once when Dart calls `RustLib.init()`: panic messages go to the Dart log.
#[frb(init)]
pub fn init_app() {
    flutter_rust_bridge::setup_default_user_utils();
}

fn err(e: core::FfiError) -> anyhow::Error {
    anyhow::anyhow!(e.to_string())
}

/// A device key. The seed is secret: keep it in the platform keystore.
pub struct DeviceKey {
    pub seed: Vec<u8>,
    pub public_key: Vec<u8>,
    pub device_id: String,
}

impl From<core::DeviceKeyRecord> for DeviceKey {
    fn from(r: core::DeviceKeyRecord) -> Self {
        DeviceKey { seed: r.seed, public_key: r.public_key, device_id: r.device_id }
    }
}

/// Generates a new Ed25519 device key.
#[frb(sync)]
pub fn new_device_key() -> DeviceKey {
    core::new_device_key().into()
}

/// The device key for a 32-byte seed.
#[frb(sync)]
pub fn device_key_from_seed(seed: Vec<u8>) -> anyhow::Result<DeviceKey> {
    core::device_key_from_seed(seed).map(Into::into).map_err(err)
}

/// Canonical JSON (spec §3).
#[frb(sync)]
pub fn canonicalize_json(json: String) -> anyhow::Result<String> {
    core::canonicalize_json(json).map_err(err)
}

/// Validation problems with an envelope (empty when valid).
#[frb(sync)]
pub fn validate_envelope_json(envelope_json: String) -> Vec<String> {
    core::validate_envelope_json(envelope_json)
}

/// A new ULID message id.
#[frb(sync)]
pub fn new_message_id() -> String {
    core::new_message_id()
}

/// Signs an envelope (spec §4) and returns it with `sender` and `sig` set.
#[frb(sync)]
pub fn sign_envelope_json(envelope_json: String, seed: Vec<u8>) -> anyhow::Result<String> {
    core::sign_envelope_json(envelope_json, seed).map_err(err)
}

/// True if the envelope's signature verifies (false if unsigned or invalid).
#[frb(sync)]
pub fn verify_envelope_json(envelope_json: String) -> bool {
    core::verify_envelope_json(envelope_json)
}

/// Encrypts an envelope's content with a 32-byte topic key (spec §5).
#[frb(sync)]
pub fn encrypt_envelope_json(envelope_json: String, key: Vec<u8>, kid: String) -> anyhow::Result<String> {
    core::encrypt_envelope_json(envelope_json, key, kid).map_err(err)
}

/// Decrypts an envelope; `None` if it isn't encrypted or the key doesn't fit.
#[frb(sync)]
pub fn decrypt_envelope_json(envelope_json: String, key: Vec<u8>) -> anyhow::Result<Option<String>> {
    core::decrypt_envelope_json(envelope_json, key).map_err(err)
}

/// Raw Ed25519 signature over `message`.
#[frb(sync)]
pub fn sign_bytes(seed: Vec<u8>, message: Vec<u8>) -> anyhow::Result<Vec<u8>> {
    core::sign_bytes(seed, message).map_err(err)
}

/// Header values for a device-signed HTTP request (spec §8.1).
pub struct SignedRequest {
    pub device_id: String,
    pub time: u64,
    pub nonce: String,
    pub signed_headers: String,
    pub signature: String,
}

/// Signs an HTTP request (`subetha-req-v2`). `headers` are (name, value) pairs the request will
/// carry; content and routing headers get signed. `nonce` `None` draws a fresh one.
#[frb(sync)]
#[allow(clippy::too_many_arguments)]
pub fn sign_request(
    seed: Vec<u8>,
    method: String,
    host: String,
    path_and_query: String,
    time: u64,
    nonce: Option<String>,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
) -> anyhow::Result<SignedRequest> {
    let headers = headers.into_iter().map(|(name, value)| core::HeaderRecord { name, value }).collect();
    let r = core::sign_request(seed, method, host, path_and_query, time, nonce, body, headers).map_err(err)?;
    Ok(SignedRequest { device_id: r.device_id, time: r.time, nonce: r.nonce, signed_headers: r.signed_headers, signature: r.signature })
}

/// Proof of key possession for `POST /v1/device/code`.
pub struct EnrollmentProof {
    pub device_id: String,
    pub time: u64,
    pub proof: String,
}

#[frb(sync)]
pub fn enrollment_proof(seed: Vec<u8>, time: u64) -> anyhow::Result<EnrollmentProof> {
    let r = core::enrollment_proof(seed, time).map_err(err)?;
    Ok(EnrollmentProof { device_id: r.device_id, time: r.time, proof: r.proof })
}
