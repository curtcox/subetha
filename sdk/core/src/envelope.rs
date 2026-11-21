//! The message envelope (spec §2) and its validation.
//!
//! [`Envelope`] is a typed view with every unknown field preserved in `extra` (forward
//! compatibility, spec §2). Signing and E2EE operate on the JSON object form so that no field
//! can be lost or reordered by a round trip; the typed helpers convert through
//! [`Envelope::to_map`] / [`Envelope::from_map`].
//!
//! [`validate_envelope`] mirrors `validateEnvelope` in `sdk/js/src/protocol/envelope.ts` and
//! works on raw JSON, so it can report problems the typed struct couldn't even parse.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::canonical::{canonicalize, MAX_SAFE_INTEGER};
use crate::sign::is_device_id;
use crate::topic::is_topic;
use crate::ulid::is_ulid;
use crate::Error;

/// Largest `message` in bytes (UTF-8).
pub const MAX_MESSAGE_BYTES: usize = 4096;
pub const CONTENT_TYPES: [&str; 4] = ["text/plain", "text/markdown", "application/json", "application/octet-stream"];
pub const EVENTS: [&str; 4] = ["message", "open", "keepalive", "poll_request"];

/// Transport ids (spec §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Ws,
    Sse,
    Poll,
    Webpush,
    Apns,
    Fcm,
    Webhook,
    Email,
    Slack,
    Sms,
    Voice,
    Mcp,
    Lxmf,
    Ble,
    Audio,
    Qr,
    Lan,
}

impl Transport {
    pub const ALL: [Transport; 17] = [
        Transport::Ws,
        Transport::Sse,
        Transport::Poll,
        Transport::Webpush,
        Transport::Apns,
        Transport::Fcm,
        Transport::Webhook,
        Transport::Email,
        Transport::Slack,
        Transport::Sms,
        Transport::Voice,
        Transport::Mcp,
        Transport::Lxmf,
        Transport::Ble,
        Transport::Audio,
        Transport::Qr,
        Transport::Lan,
    ];
    pub const EDGE: [Transport; 4] = [Transport::Ble, Transport::Audio, Transport::Qr, Transport::Lan];

    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Ws => "ws",
            Transport::Sse => "sse",
            Transport::Poll => "poll",
            Transport::Webpush => "webpush",
            Transport::Apns => "apns",
            Transport::Fcm => "fcm",
            Transport::Webhook => "webhook",
            Transport::Email => "email",
            Transport::Slack => "slack",
            Transport::Sms => "sms",
            Transport::Voice => "voice",
            Transport::Mcp => "mcp",
            Transport::Lxmf => "lxmf",
            Transport::Ble => "ble",
            Transport::Audio => "audio",
            Transport::Qr => "qr",
            Transport::Lan => "lan",
        }
    }

    /// Edge transports (`ble`, `audio`, `qr`, `lan`) work without the relay.
    pub fn is_edge(self) -> bool {
        Self::EDGE.contains(&self)
    }
}

impl fmt::Display for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Transport {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self, Error> {
        Self::ALL
            .iter()
            .copied()
            .find(|t| t.as_str() == s)
            .ok_or_else(|| Error::Envelope(format!("unknown transport: {s}")))
    }
}

/// Route modes (PLAN §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteMode {
    /// Deliver once by the cheapest viable path, escalating if unacked (default).
    #[default]
    Any,
    /// Lowest latency first.
    Fast,
    /// Every allowed transport at once (alarms).
    All,
    /// Free/edge transports only; never escalate to paid ones.
    Cheap,
}

impl FromStr for RouteMode {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "any" => Ok(RouteMode::Any),
            "fast" => Ok(RouteMode::Fast),
            "all" => Ok(RouteMode::All),
            "cheap" => Ok(RouteMode::Cheap),
            _ => Err(Error::Envelope(format!("unknown route mode: {s}"))),
        }
    }
}

/// An ntfy action button. Unknown keys are preserved.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Action {
    pub action: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Attachment {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Per-message routing preferences. Modes and transports are kept as strings so an envelope
/// from a newer protocol version still parses; see [`Route::mode`] and [`Route::allow_list`].
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Route {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cost_usd_micros: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_s: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Route {
    /// The route mode, defaulting to `any`. Unknown modes are an error.
    pub fn route_mode(&self) -> Result<RouteMode, Error> {
        self.mode.as_deref().map_or(Ok(RouteMode::Any), str::parse)
    }

    /// Parsed allow list (`None` = unrestricted). Unknown transport ids are skipped.
    pub fn allow_list(&self) -> Option<Vec<Transport>> {
        self.allow.as_ref().map(|v| v.iter().filter_map(|s| s.parse().ok()).collect())
    }

    /// Parsed deny list. Unknown transport ids are skipped.
    pub fn deny_list(&self) -> Vec<Transport> {
        self.deny.iter().flatten().filter_map(|s| s.parse().ok()).collect()
    }
}

/// E2EE block (spec §5).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Enc {
    pub alg: String,
    pub kid: String,
    pub nonce: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A SubEtha message envelope. Unknown fields round-trip through `extra`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default)]
    pub topic: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub click: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<Action>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enc: Option<Enc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<Route>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hops: Option<i64>,
    /// Fields this version doesn't know about. Preserved verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Envelope {
    /// A minimal message envelope.
    pub fn new(topic: impl Into<String>, message: impl Into<String>) -> Self {
        Envelope { topic: topic.into(), message: Some(message.into()), ..Default::default() }
    }

    /// Sets `id` (fresh ULID) and `time` (now) if they are missing, as a signer must.
    pub fn with_id_and_time(mut self) -> Self {
        if self.id.is_none() {
            self.id = Some(crate::ulid::ulid());
        }
        if self.time.is_none() {
            self.time = Some(crate::ulid::now_secs() as i64);
        }
        self
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("envelope serializes")
    }

    pub fn to_map(&self) -> Map<String, Value> {
        match self.to_value() {
            Value::Object(m) => m,
            _ => unreachable!("envelope serializes to an object"),
        }
    }

    pub fn from_value(v: Value) -> Result<Self, Error> {
        Ok(serde_json::from_value(v)?)
    }

    pub fn from_map(m: Map<String, Value>) -> Result<Self, Error> {
        Self::from_value(Value::Object(m))
    }

    pub fn from_json(s: &str) -> Result<Self, Error> {
        Ok(serde_json::from_str(s)?)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("envelope serializes")
    }

    /// Validation problems (empty = valid). See [`validate_envelope`].
    pub fn validate(&self) -> Vec<String> {
        validate_envelope(&self.to_value())
    }

    /// Effective priority (3 when omitted).
    pub fn effective_priority(&self) -> i64 {
        self.priority.unwrap_or(3)
    }

    /// Effective hop budget (0 when omitted).
    pub fn hops_remaining(&self) -> i64 {
        self.hops.unwrap_or(0)
    }

    /// `true` if `expires` is set and earlier than `now_secs`.
    pub fn is_expired(&self, now_secs: u64) -> bool {
        self.expires.is_some_and(|e| e < now_secs as i64)
    }
}

fn is_int(v: &Value, min: i64, max: i64) -> bool {
    v.as_number()
        .and_then(|n| crate::canonical::safe_integer(n).ok())
        .is_some_and(|i| i >= min && i <= max)
}

fn is_str(v: &Value, max_bytes: usize) -> bool {
    v.as_str().is_some_and(|s| s.len() <= max_bytes)
}

fn is_transport_list(v: Option<&Value>) -> bool {
    match v {
        None => true,
        Some(Value::Array(a)) => a.iter().all(|t| t.as_str().is_some_and(|s| s.parse::<Transport>().is_ok())),
        Some(_) => false,
    }
}

fn is_b64url(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Validates an envelope against the v0 schema. Returns a list of problems (empty = valid).
///
/// Mirrors `validateEnvelope` in the TS reference, check for check and message for message.
pub fn validate_envelope(env: &Value) -> Vec<String> {
    let Some(e) = env.as_object() else {
        return vec!["envelope must be an object".into()];
    };
    let mut errs = Vec::new();
    let mut opt = |k: &str, ok: &dyn Fn(&Value) -> bool, why: &str| {
        if let Some(v) = e.get(k) {
            if !v.is_null() && !ok(v) {
                errs.push(format!("{k}: {why}"));
            }
        }
    };
    let max = MAX_SAFE_INTEGER;
    opt("id", &|v| v.as_str().is_some_and(is_ulid), "must be a ULID");
    opt("time", &|v| is_int(v, 0, max), "must be a non-negative integer");
    opt("expires", &|v| is_int(v, 0, max), "must be a non-negative integer");
    opt("event", &|v| v.as_str().is_some_and(|s| EVENTS.contains(&s)), "unknown event");
    opt("title", &|v| is_str(v, 256), "string up to 256 bytes");
    opt("message", &|v| is_str(v, MAX_MESSAGE_BYTES), "string up to 4096 bytes");
    opt("priority", &|v| is_int(v, 1, 5), "integer 1..5");
    opt(
        "tags",
        &|v| v.as_array().is_some_and(|a| a.len() <= 16 && a.iter().all(|t| is_str(t, 64))),
        "up to 16 strings",
    );
    opt("click", &|v| is_str(v, 2048), "string");
    opt("icon", &|v| is_str(v, 2048), "string");
    opt(
        "actions",
        &|v| {
            v.as_array().is_some_and(|a| {
                a.len() <= 3
                    && a.iter().all(|x| {
                        x.get("action").and_then(Value::as_str).is_some_and(|s| ["view", "http", "broadcast"].contains(&s))
                            && x.get("label").is_some_and(Value::is_string)
                    })
            })
        },
        "up to 3 actions with action and label",
    );
    opt(
        "attachment",
        &|v| v.is_object() && v.get("name").is_some_and(Value::is_string) && v.get("url").is_some_and(Value::is_string),
        "needs name and url",
    );
    opt("content_type", &|v| v.as_str().is_some_and(|s| CONTENT_TYPES.contains(&s)), "unsupported content type");
    opt("sender", &|v| v.as_str().is_some_and(is_device_id), "must be a device id");
    opt(
        "sig",
        &|v| v.as_str().and_then(|s| s.strip_prefix("ed25519:")).is_some_and(|s| is_b64url(s, 86)),
        "must be ed25519:<base64url>",
    );
    opt(
        "enc",
        &|v| {
            v.is_object()
                && v.get("alg").and_then(Value::as_str) == Some("xchacha20poly1305")
                && v.get("kid").is_some_and(Value::is_string)
                && v.get("nonce").and_then(Value::as_str).is_some_and(|s| is_b64url(s, 32))
        },
        "invalid enc block",
    );
    opt(
        "route",
        &|v| {
            let Some(r) = v.as_object() else { return false };
            r.get("mode").is_none_or(|m| m.as_str().is_some_and(|s| s.parse::<RouteMode>().is_ok()))
                && r.get("max_cost_usd_micros").is_none_or(|x| is_int(x, 0, max))
                && r.get("deadline_s").is_none_or(|x| is_int(x, 1, max))
                && is_transport_list(r.get("deny"))
                && is_transport_list(r.get("allow"))
        },
        "invalid route block",
    );
    opt("hops", &|v| is_int(v, 0, 16), "integer 0..16");
    // Topic is checked first in TS; keep the same output order.
    if !e.get("topic").and_then(Value::as_str).is_some_and(is_topic) {
        errs.insert(0, "topic: invalid topic name".into());
    }
    // Integers only, anywhere (spec §2).
    if let Err(err) = canonicalize(env) {
        let msg = match err {
            Error::Canonical(m) => m,
            other => other.to_string(),
        };
        errs.push(format!("envelope: {msg}"));
    }
    errs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_fields_roundtrip() {
        let v = json!({
            "topic": "@a/b", "message": "m", "x_future": {"n": [1, 2]},
            "actions": [{"action": "view", "label": "L", "x_extra": true}],
            "route": {"mode": "warp", "x": 1},
            "enc": {"alg": "xchacha20poly1305", "kid": "k", "nonce": "n", "v": 2}
        });
        let e = Envelope::from_value(v.clone()).unwrap();
        assert_eq!(e.extra["x_future"], json!({"n": [1, 2]}));
        assert_eq!(e.to_value(), v);
        assert!(e.route.as_ref().unwrap().route_mode().is_err());
    }

    #[test]
    fn nulls_are_absent() {
        let e = Envelope::from_value(json!({"topic": "@a/b", "title": null})).unwrap();
        assert_eq!(e.title, None);
        assert_eq!(e.to_value(), json!({"topic": "@a/b"}));
    }

    #[test]
    fn validation_mirrors_ts() {
        assert!(validate_envelope(&json!({"topic": "@a/b", "message": "hi", "priority": 4})).is_empty());
        assert_eq!(validate_envelope(&json!([])), vec!["envelope must be an object"]);
        let errs = validate_envelope(&json!({
            "topic": "nope", "id": "x", "time": -1, "priority": 7, "hops": 17, "event": "boom",
            "tags": vec!["a"; 17], "sender": "dev_x", "sig": "ed25519:abc", "content_type": "text/html",
            "route": {"mode": "slow"}, "attachment": {"name": "n"}, "actions": [{"action": "view"}],
            "enc": {"alg": "aes", "kid": "k", "nonce": "n"}, "extra": 1.5
        }));
        let fields: Vec<&str> = errs.iter().map(|e| e.split(':').next().unwrap()).collect();
        assert_eq!(
            fields,
            vec![
                "topic", "id", "time", "event", "priority", "tags", "actions", "attachment", "content_type", "sender",
                "sig", "enc", "route", "hops", "envelope"
            ]
        );
        assert!(validate_envelope(&json!({"topic": "@a/b", "message": "x".repeat(4097)}))[0].starts_with("message:"));
        assert!(validate_envelope(&json!({"topic": "@a/b", "route": {"deny": ["carrier-pigeon"]}}))[0].starts_with("route:"));
        assert!(validate_envelope(&json!({"topic": "@a/b", "route": {"allow": ["ble"], "deadline_s": 0}}))[0].starts_with("route:"));
    }

    #[test]
    fn transports() {
        for t in Transport::ALL {
            assert_eq!(t.as_str().parse::<Transport>().unwrap(), t);
            assert_eq!(serde_json::to_value(t).unwrap(), json!(t.as_str()));
        }
        assert!(Transport::Qr.is_edge() && !Transport::Sms.is_edge());
    }

    #[test]
    fn helpers() {
        let e = Envelope::new("@a/b", "hi").with_id_and_time();
        assert!(is_ulid(e.id.as_deref().unwrap()));
        assert!(e.validate().is_empty());
        assert_eq!(e.effective_priority(), 3);
        assert_eq!(e.hops_remaining(), 0);
        let e = Envelope { expires: Some(10), ..e };
        assert!(e.is_expired(11) && !e.is_expired(10));
        assert_eq!(Envelope::from_json(&e.to_json()).unwrap(), e);
    }
}
