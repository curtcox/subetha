//! SubEtha core SDK.
//!
//! Protocol (spec v0, `spec/README.md`):
//! [`encoding`], [`canonical`], [`topic`], [`ulid`], [`envelope`], [`sign`], [`e2ee`], [`dedupe`].
//!
//! Delivery: [`store`] (store-and-forward outbox) and [`routing`] (delivery plans and policy
//! intersection).
//!
//! Edge transports (pure protocol logic; platform shims supply the radios, speakers and
//! cameras): [`edge::audio`], [`edge::qr`], [`edge::gossip`], [`edge::ble`].
//!
//! Bindings: [`ffi`] (string/bytes helpers shaped for UniFFI; see `BINDINGS.md`).

#![forbid(unsafe_code)]

pub mod canonical;
pub mod crc;
pub mod dedupe;
pub mod e2ee;
// pub mod edge;
pub mod encoding;
pub mod envelope;
// pub mod ffi;
pub mod random;
pub mod routing;
pub mod sign;
pub mod store;
pub mod topic;
pub mod ulid;

pub use canonical::{canonical_envelope, canonicalize};
pub use dedupe::Deduper;
pub use e2ee::{decrypt_envelope, encrypt_envelope};
pub use envelope::{validate_envelope, Envelope};
pub use sign::{sign_envelope, verify_envelope, DeviceKey};

/// Errors returned by the core SDK.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("encoding: {0}")]
    Encoding(String),
    #[error("canonical: {0}")]
    Canonical(String),
    #[error("invalid ulid")]
    InvalidUlid,
    #[error("invalid device id")]
    InvalidDeviceId,
    #[error("invalid key: {0}")]
    InvalidKey(String),
    #[error("signing: {0}")]
    Signing(String),
    #[error("encryption: {0}")]
    Encryption(String),
    #[error("envelope: {0}")]
    Envelope(String),
    #[error("json: {0}")]
    Json(String),
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e.to_string())
    }
}
