//! Binding-friendly store-and-forward outbox and receiver dedupe (PLAN §5 steps 4–5), so the
//! mobile SDKs can queue messages while offline and drop duplicates across transports.
//! Envelopes cross the boundary as JSON text. See `BINDINGS.md`.

use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Value};

use crate::dedupe::Deduper;
use crate::ffi::FfiError;
use crate::store::{DropReason, EnqueueResult, Outbox, OutboxItem, RetryPolicy};
use crate::Envelope;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn fail(msg: impl Into<String>) -> FfiError {
    FfiError::Failed { msg: msg.into() }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OutboxItemRecord {
    pub id: String,
    pub envelope_json: String,
    pub attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OutboxEnqueueRecord {
    /// "queued", "duplicate", or "expired".
    pub result: String,
    /// Set when the queue was full and its oldest item was evicted to make room.
    pub evicted_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OutboxDroppedRecord {
    pub id: String,
    pub envelope_json: String,
    /// "expired", "max_attempts", or "overflow".
    pub reason: String,
}

fn drop_reason(r: DropReason) -> &'static str {
    match r {
        DropReason::Expired => "expired",
        DropReason::MaxAttempts => "max_attempts",
        DropReason::Overflow => "overflow",
    }
}

/// Outgoing messages waiting for an ack, retried with exponential backoff. The caller supplies
/// the clock (ms) and persists `to_json()` across restarts.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct CoreOutbox {
    inner: Mutex<Outbox<String>>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl CoreOutbox {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(base_backoff_ms: u64, max_backoff_ms: u64, max_attempts: Option<u32>, capacity: u32) -> Arc<Self> {
        let policy = RetryPolicy { base_backoff_ms, max_backoff_ms, max_attempts };
        Arc::new(CoreOutbox { inner: Mutex::new(Outbox::new(policy, capacity as usize)) })
    }

    /// Queues a (signed/encrypted) envelope by its id; due immediately. It must have an id.
    pub fn enqueue(&self, envelope_json: String, now_ms: u64) -> Result<OutboxEnqueueRecord, FfiError> {
        let env = Envelope::from_json(&envelope_json)?;
        let id = env.id.clone().ok_or_else(|| fail("envelope needs an id to be queued"))?;
        let expires_ms = env.expires.map(|s| (s.max(0) as u64).saturating_mul(1000));
        let (r, evicted) = lock(&self.inner).enqueue(&id, envelope_json, now_ms, expires_ms);
        let result = match r {
            EnqueueResult::Queued => "queued",
            EnqueueResult::Duplicate => "duplicate",
            EnqueueResult::Expired => "expired",
        };
        Ok(OutboxEnqueueRecord { result: result.into(), evicted_id: evicted.map(|(it, _)| it.id) })
    }

    /// Items due now. Each counts as an attempt and comes back after a backoff unless acked.
    pub fn poll(&self, now_ms: u64) -> Vec<OutboxItemRecord> {
        lock(&self.inner)
            .poll(now_ms)
            .into_iter()
            .map(|it| OutboxItemRecord { id: it.id, envelope_json: it.payload, attempts: it.attempts })
            .collect()
    }

    /// Removes an item once the relay or a peer confirmed it. False if it wasn't queued.
    pub fn ack(&self, id: String) -> bool {
        lock(&self.inner).ack(&id)
    }

    /// Records a failed attempt now; returns when it will be retried.
    pub fn nack(&self, id: String, now_ms: u64) -> Option<u64> {
        lock(&self.inner).nack(&id, now_ms)
    }

    /// Makes an item due immediately (e.g. when connectivity returns).
    pub fn retry_now(&self, id: String, now_ms: u64) -> bool {
        lock(&self.inner).retry_now(&id, now_ms)
    }

    /// Drops expired items and items out of attempts, returning them (dead letters).
    pub fn expire(&self, now_ms: u64) -> Vec<OutboxDroppedRecord> {
        lock(&self.inner)
            .expire(now_ms)
            .into_iter()
            .map(|(it, r)| OutboxDroppedRecord { id: it.id, envelope_json: it.payload, reason: drop_reason(r).into() })
            .collect()
    }

    /// When the next item falls due (ms), to schedule a timer.
    pub fn next_wake_ms(&self) -> Option<u64> {
        lock(&self.inner).next_wake_ms()
    }

    pub fn len(&self) -> u64 {
        lock(&self.inner).len() as u64
    }

    pub fn is_empty(&self) -> bool {
        lock(&self.inner).is_empty()
    }

    /// The queue as JSON, to persist.
    pub fn to_json(&self) -> String {
        let items: Vec<Value> = lock(&self.inner)
            .items()
            .map(|it| {
                json!({
                    "id": it.id, "envelope": it.payload, "enqueued_ms": it.enqueued_ms, "expires_ms": it.expires_ms,
                    "attempts": it.attempts, "next_attempt_ms": it.next_attempt_ms,
                })
            })
            .collect();
        Value::Array(items).to_string()
    }

    /// Adds items saved with `to_json()`.
    pub fn restore_json(&self, json: String) -> Result<(), FfiError> {
        let v: Vec<Value> = serde_json::from_str(&json).map_err(|e| fail(format!("bad outbox JSON: {e}")))?;
        let mut items = Vec::with_capacity(v.len());
        for x in v {
            let s = |k: &str| x[k].as_str().map(str::to_owned).ok_or_else(|| fail(format!("outbox item missing {k}")));
            let n = |k: &str| x[k].as_u64().ok_or_else(|| fail(format!("outbox item missing {k}")));
            items.push(OutboxItem {
                id: s("id")?,
                payload: s("envelope")?,
                enqueued_ms: n("enqueued_ms")?,
                expires_ms: x["expires_ms"].as_u64(),
                attempts: n("attempts")? as u32,
                next_attempt_ms: n("next_attempt_ms")?,
            });
        }
        lock(&self.inner).restore(items);
        Ok(())
    }
}

/// Receiver-side dedupe across transports (spec §6).
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct CoreDeduper {
    inner: Mutex<Deduper>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl CoreDeduper {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(capacity: u32) -> Arc<Self> {
        Arc::new(CoreDeduper { inner: Mutex::new(Deduper::new(capacity as usize)) })
    }

    /// True if the message is new (and records it). Expired messages are never new.
    pub fn accept(&self, id: Option<String>, expires_secs: Option<u64>, now_secs: u64) -> bool {
        lock(&self.inner).accept(id.as_deref(), expires_secs, now_secs)
    }

    /// `accept` for an envelope in JSON.
    pub fn accept_envelope(&self, envelope_json: String, now_secs: u64) -> Result<bool, FfiError> {
        let env = Envelope::from_json(&envelope_json)?;
        Ok(lock(&self.inner).accept_envelope(&env, now_secs))
    }

    pub fn has(&self, id: String) -> bool {
        lock(&self.inner).has(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(id: &str, expires: Option<i64>) -> String {
        let mut v = json!({ "id": id, "topic": "@a/b", "message": "m" });
        if let Some(e) = expires {
            v["expires"] = json!(e);
        }
        v.to_string()
    }

    #[test]
    fn outbox_retries_acks_expires_and_persists() {
        let o = CoreOutbox::new(1_000, 10_000, Some(3), 2);
        let a = "01JD5A2Z3K8Q9V6X7W4T1R0S2M";
        let b = "01JD5A2Z3K8Q9V6X7W4T1R0S2N";
        assert_eq!(o.enqueue(env(a, None), 0).unwrap().result, "queued");
        assert_eq!(o.enqueue(env(a, None), 0).unwrap().result, "duplicate");
        assert_eq!(o.enqueue(env(b, Some(5)), 0).unwrap().result, "queued");
        assert_eq!(o.poll(0).len(), 2);
        assert!(o.poll(500).is_empty()); // backing off
        assert_eq!(o.next_wake_ms(), Some(1_000));
        assert!(o.ack(a.into()));
        let dead = o.expire(6_000);
        assert_eq!(dead.iter().map(|d| (d.id.as_str(), d.reason.as_str())).collect::<Vec<_>>(), vec![(b, "expired")]);
        assert!(o.enqueue(r#"{"topic":"@a/b"}"#.into(), 0).is_err());

        let c = "01JD5A2Z3K8Q9V6X7W4T1R0S2P";
        o.enqueue(env(c, None), 10).unwrap();
        let saved = o.to_json();
        let o2 = CoreOutbox::new(1_000, 10_000, Some(3), 2);
        o2.restore_json(saved).unwrap();
        assert_eq!(o2.len(), 1);
        assert_eq!(o2.poll(10)[0].id, c);
        // Overflow evicts the oldest.
        o2.enqueue(env(a, None), 20).unwrap();
        assert_eq!(o2.enqueue(env(b, None), 20).unwrap().evicted_id.as_deref(), Some(c));
    }

    #[test]
    fn deduper_drops_repeats_and_expired() {
        let d = CoreDeduper::new(100);
        assert!(d.accept(Some("01JD5A2Z3K8Q9V6X7W4T1R0S2M".into()), None, 10));
        assert!(!d.accept(Some("01jd5a2z3k8q9v6x7w4t1r0s2m".into()), None, 10));
        assert!(!d.accept_envelope(env("01JD5A2Z3K8Q9V6X7W4T1R0S2N", Some(5)), 10).unwrap());
        assert!(d.has("01JD5A2Z3K8Q9V6X7W4T1R0S2M".into()));
    }
}
