//! Device-signed HTTP requests (spec §8.1, `subetha-req-v2`).
//!
//! The signature covers the method, host, path and query, the body's SHA-256, and the value of
//! every header named in `X-Device-Signed-Headers`. Relays reject a signed request that carries
//! a content or routing header ([`COVERED_REQUEST_HEADERS`]) without signing it.

use sha2::Digest;

use crate::encoding::{base64url_encode, hex_encode};
use crate::sign::DeviceKey;
use crate::Error;

pub const REQ_V2_DOMAIN: &str = "subetha-req-v2";

/// Headers every signature must list.
pub const REQUIRED_SIGNED_HEADERS: [&str; 3] = ["x-device-id", "x-device-time", "x-device-nonce"];

pub const MAX_SIGNED_HEADERS: usize = 32;

/// Headers a relay refuses to accept unsigned on a device-signed request (spec §8.1).
pub const COVERED_REQUEST_HEADERS: &[&str] = &[
    "content-type", "content-encoding", "idempotency-key",
    "x-title", "title", "t",
    "x-priority", "priority", "prio", "p",
    "x-tags", "tags", "tag", "ta",
    "x-click", "click",
    "x-icon", "icon",
    "x-attach", "attach", "a",
    "x-markdown", "markdown", "md",
    "x-actions", "actions", "action",
    "x-filename", "filename", "file", "f",
    "x-message", "message", "m",
    "x-delay", "delay", "x-at", "at", "x-in", "in",
    "x-email", "email", "e", "x-call", "call",
    "x-cache", "cache", "x-firebase", "firebase", "x-unifiedpush", "unifiedpush", "up",
    "x-poll-id", "poll-id",
    "x-sender", "x-signature", "x-message-id", "x-time", "x-expires", "x-content-type", "x-hops",
    "x-route-mode", "x-max-cost", "x-deny", "x-allow", "x-deadline", "x-dry-run",
];

/// A header value as signed: surrounding spaces and tabs removed.
pub fn canonical_header_value(v: &str) -> &str {
    v.trim_matches(|c| c == ' ' || c == '\t')
}

/// The signing input: `subetha-req-v2\nMETHOD\nhost\npath?query\nhex(sha256(body))`, then
/// `\nname:value` per signed header in order. `host` is WHATWG `URL.host` (lowercase, `:port`
/// only when not the scheme's default); `path_and_query` is the path plus `?query` if any.
pub fn signing_input_v2(method: &str, host: &str, path_and_query: &str, body: &[u8], headers: &[(String, String)]) -> String {
    let mut s = format!("{REQ_V2_DOMAIN}\n{}\n{host}\n{path_and_query}\n{}", method.to_uppercase(), hex_encode(&sha2::Sha256::digest(body)));
    for (n, v) in headers {
        s.push('\n');
        s.push_str(&n.to_lowercase());
        s.push(':');
        s.push_str(canonical_header_value(v));
    }
    s
}

/// Headers the SDKs don't sign: credentials, and headers HTTP stacks set or rewrite themselves.
pub const UNSIGNED_BY_CONVENTION: [&str; 8] = ["authorization", "host", "content-length", "connection", "transfer-encoding", "user-agent", "accept", "accept-encoding"];

/// The SDK convention: X-Device-Id, -Time, -Nonce, then the other headers lowercased and
/// sorted by name, skipping [`UNSIGNED_BY_CONVENTION`] and any other `x-device-*` header.
pub fn headers_to_sign(device_id: &str, time: u64, nonce: &str, headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut rest: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    for (k, v) in headers {
        let n = k.to_lowercase();
        if UNSIGNED_BY_CONVENTION.contains(&n.as_str()) || n.starts_with("x-device-") {
            continue;
        }
        rest.insert(n, v.clone());
    }
    let mut out = vec![
        ("x-device-id".to_owned(), device_id.to_owned()),
        ("x-device-time".to_owned(), time.to_string()),
        ("x-device-nonce".to_owned(), nonce.to_owned()),
    ];
    out.extend(rest);
    out
}

/// True for a valid request nonce: 16–64 base64url characters.
pub fn valid_nonce(nonce: &str) -> bool {
    (16..=64).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The X-Device-* header values for one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub device_id: String,
    pub time: u64,
    pub nonce: String,
    /// `X-Device-Signed-Headers`.
    pub signed_headers: String,
    /// `X-Device-Signature`.
    pub signature: String,
}

impl SignedRequest {
    /// The headers to add to the request (send `headers` unchanged as well).
    pub fn headers(&self) -> Vec<(String, String)> {
        vec![
            ("X-Device-Id".into(), self.device_id.clone()),
            ("X-Device-Time".into(), self.time.to_string()),
            ("X-Device-Nonce".into(), self.nonce.clone()),
            ("X-Device-Signed-Headers".into(), self.signed_headers.clone()),
            ("X-Device-Signature".into(), self.signature.clone()),
        ]
    }
}

/// Signs a request. `headers` are the headers the request will carry ([`UNSIGNED_BY_CONVENTION`]
/// ones are skipped).
#[allow(clippy::too_many_arguments)]
pub fn sign_request(key: &DeviceKey, method: &str, host: &str, path_and_query: &str, time: u64, nonce: &str, body: &[u8], headers: &[(String, String)]) -> Result<SignedRequest, Error> {
    if !valid_nonce(nonce) {
        return Err(Error::Signing("nonce must be 16-64 base64url characters".into()));
    }
    let signed = headers_to_sign(key.device_id(), time, nonce, headers);
    if signed.len() > MAX_SIGNED_HEADERS {
        return Err(Error::Signing(format!("at most {MAX_SIGNED_HEADERS} signed headers")));
    }
    let input = signing_input_v2(method, host, path_and_query, body, &signed);
    Ok(SignedRequest {
        device_id: key.device_id().to_owned(),
        time,
        nonce: nonce.to_owned(),
        signed_headers: signed.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(","),
        signature: base64url_encode(&key.sign_bytes(input.as_bytes())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convention_and_trimming() {
        let h = vec![("X-Title".to_owned(), " Door\t".to_owned()), ("Authorization".to_owned(), "Bearer x".to_owned()), ("content-type".to_owned(), "text/plain".to_owned())];
        let s = headers_to_sign("dev_x", 5, "n", &h);
        let names: Vec<&str> = s.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["x-device-id", "x-device-time", "x-device-nonce", "content-type", "x-title"]);
        let input = signing_input_v2("get", "x.test", "/", b"", &s);
        assert!(input.ends_with("\ncontent-type:text/plain\nx-title:Door"));
        assert!(input.starts_with("subetha-req-v2\nGET\nx.test\n/\ne3b0c442"));
    }

    #[test]
    fn rejects_bad_nonce_and_too_many_headers() {
        let k = DeviceKey::from_seed(&[1; 32]);
        assert!(sign_request(&k, "GET", "x.test", "/", 1, "short", b"", &[]).is_err());
        let many: Vec<(String, String)> = (0..30).map(|i| (format!("x-h{i}"), "v".into())).collect();
        assert!(sign_request(&k, "GET", "x.test", "/", 1, "nonce_0123456789abcdef", b"", &many).is_err());
    }
}
