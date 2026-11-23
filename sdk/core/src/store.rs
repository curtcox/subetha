//! Store-and-forward outbox (PLAN §5 step 5).
//!
//! An in-memory queue of outgoing items keyed by message id. The caller drives it with a
//! clock (milliseconds) so it is deterministic and testable:
//!
//! 1. [`Outbox::enqueue`] an item (idempotent by id).
//! 2. [`Outbox::poll`] returns items that are due; each returned item counts as an attempt and
//!    is rescheduled with exponential backoff, so it comes back if no ack arrives.
//! 3. [`Outbox::ack`] removes an item once the relay or a peer confirms it (idempotent).
//! 4. [`Outbox::expire`] drops items past their expiry or out of attempts and hands them back
//!    (dead letters) so the app can report them.
//!
//! Persisting the queue is the platform shim's job; [`Outbox::items`] and
//! [`Outbox::restore`] make that straightforward.

use std::collections::BTreeMap;

use crate::envelope::Envelope;

/// Retry policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Delay after the first attempt.
    pub base_backoff_ms: u64,
    /// Upper bound on any single delay.
    pub max_backoff_ms: u64,
    /// Give up after this many attempts (`None` = retry until expiry).
    pub max_attempts: Option<u32>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy { base_backoff_ms: 1_000, max_backoff_ms: 5 * 60_000, max_attempts: None }
    }
}

impl RetryPolicy {
    /// Delay before the next attempt after `attempts` attempts (>= 1): `base * 2^(attempts-1)`,
    /// capped at `max_backoff_ms`.
    pub fn backoff_ms(&self, attempts: u32) -> u64 {
        let shift = attempts.saturating_sub(1).min(63);
        self.base_backoff_ms.saturating_mul(1u64 << shift).min(self.max_backoff_ms)
    }
}

/// A queued item.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxItem<T> {
    pub id: String,
    pub payload: T,
    pub enqueued_ms: u64,
    /// Absolute expiry (ms). `None` = never.
    pub expires_ms: Option<u64>,
    pub attempts: u32,
    pub next_attempt_ms: u64,
}

/// Why an item left the queue without an ack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DropReason {
    Expired,
    MaxAttempts,
    /// Evicted to make room (queue at capacity).
    Overflow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnqueueResult {
    Queued,
    /// Already queued under this id; nothing changed.
    Duplicate,
    /// Already expired at enqueue time; not queued.
    Expired,
}

#[derive(Debug, Clone)]
pub struct Outbox<T> {
    policy: RetryPolicy,
    capacity: usize,
    items: BTreeMap<String, OutboxItem<T>>,
    /// Ids in enqueue order, for overflow eviction and stable ordering.
    order: BTreeMap<u64, String>,
    seq: u64,
    seqs: BTreeMap<String, u64>,
}

impl<T: Clone> Outbox<T> {
    pub fn new(policy: RetryPolicy, capacity: usize) -> Self {
        Outbox {
            policy,
            capacity: capacity.max(1),
            items: BTreeMap::new(),
            order: BTreeMap::new(),
            seq: 0,
            seqs: BTreeMap::new(),
        }
    }

    pub fn policy(&self) -> &RetryPolicy {
        &self.policy
    }

    /// Queues `payload` under `id`, due immediately. When full, the oldest item is evicted
    /// and returned.
    pub fn enqueue(
        &mut self,
        id: &str,
        payload: T,
        now_ms: u64,
        expires_ms: Option<u64>,
    ) -> (EnqueueResult, Option<(OutboxItem<T>, DropReason)>) {
        let id = id.to_ascii_uppercase();
        if self.items.contains_key(&id) {
            return (EnqueueResult::Duplicate, None);
        }
        if expires_ms.is_some_and(|e| e <= now_ms) {
            return (EnqueueResult::Expired, None);
        }
        let mut evicted = None;
        if self.items.len() >= self.capacity {
            if let Some((_, oldest)) = self.order.first_key_value().map(|(s, i)| (*s, i.clone())) {
                evicted = self.remove(&oldest).map(|it| (it, DropReason::Overflow));
            }
        }
        self.seq += 1;
        self.order.insert(self.seq, id.clone());
        self.seqs.insert(id.clone(), self.seq);
        self.items.insert(
            id.clone(),
            OutboxItem { id, payload, enqueued_ms: now_ms, expires_ms, attempts: 0, next_attempt_ms: now_ms },
        );
        (EnqueueResult::Queued, evicted)
    }

    /// Queues an envelope by its id and `expires` (Unix seconds).
    pub fn enqueue_envelope(&mut self, env: &Envelope, now_ms: u64) -> Option<EnqueueResult>
    where
        T: From<Envelope>,
    {
        let id = env.id.as_deref()?;
        let expires_ms = env.expires.map(|s| (s.max(0) as u64).saturating_mul(1000));
        Some(self.enqueue(id, T::from(env.clone()), now_ms, expires_ms).0)
    }

    fn remove(&mut self, id: &str) -> Option<OutboxItem<T>> {
        let it = self.items.remove(id)?;
        if let Some(s) = self.seqs.remove(id) {
            self.order.remove(&s);
        }
        Some(it)
    }

    /// Items due at `now_ms` (not expired, not out of attempts), oldest first. Each counts as
    /// an attempt and is rescheduled with backoff.
    pub fn poll(&mut self, now_ms: u64) -> Vec<OutboxItem<T>> {
        let max = self.policy.max_attempts;
        let ids: Vec<String> = self
            .order
            .values()
            .filter(|id| {
                let it = &self.items[id.as_str()];
                it.next_attempt_ms <= now_ms
                    && it.expires_ms.is_none_or(|e| e > now_ms)
                    && max.is_none_or(|m| it.attempts < m)
            })
            .cloned()
            .collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let it = self.items.get_mut(&id).expect("present");
            it.attempts += 1;
            it.next_attempt_ms = now_ms.saturating_add(self.policy.backoff_ms(it.attempts));
            out.push(it.clone());
        }
        out
    }

    /// Reports a failed send so the item is retried no sooner than its backoff allows
    /// (useful when the transport fails synchronously). Returns the next attempt time.
    pub fn nack(&mut self, id: &str, now_ms: u64) -> Option<u64> {
        let it = self.items.get_mut(&id.to_ascii_uppercase())?;
        it.next_attempt_ms = now_ms.saturating_add(self.policy.backoff_ms(it.attempts.max(1)));
        Some(it.next_attempt_ms)
    }

    /// Makes an item due immediately (e.g. a better transport just came up).
    pub fn retry_now(&mut self, id: &str, now_ms: u64) -> bool {
        self.items.get_mut(&id.to_ascii_uppercase()).map(|it| it.next_attempt_ms = now_ms).is_some()
    }

    /// Acknowledges delivery; removes the item. Idempotent: returns `false` if unknown.
    pub fn ack(&mut self, id: &str) -> bool {
        self.remove(&id.to_ascii_uppercase()).is_some()
    }

    /// Removes and returns items that expired or ran out of attempts.
    pub fn expire(&mut self, now_ms: u64) -> Vec<(OutboxItem<T>, DropReason)> {
        let max = self.policy.max_attempts;
        let dead: Vec<(String, DropReason)> = self
            .items
            .values()
            .filter_map(|it| {
                if it.expires_ms.is_some_and(|e| e <= now_ms) {
                    Some((it.id.clone(), DropReason::Expired))
                } else if max.is_some_and(|m| it.attempts >= m) && it.next_attempt_ms <= now_ms {
                    // The last attempt had its full backoff window to be acked.
                    Some((it.id.clone(), DropReason::MaxAttempts))
                } else {
                    None
                }
            })
            .collect();
        dead.into_iter().filter_map(|(id, why)| self.remove(&id).map(|it| (it, why))).collect()
    }

    /// Earliest time anything becomes due or expires (for scheduling a wake-up).
    pub fn next_wake_ms(&self) -> Option<u64> {
        self.items.values().flat_map(|it| [Some(it.next_attempt_ms), it.expires_ms]).flatten().min()
    }

    pub fn get(&self, id: &str) -> Option<&OutboxItem<T>> {
        self.items.get(&id.to_ascii_uppercase())
    }

    /// All items in enqueue order (for persistence).
    pub fn items(&self) -> impl Iterator<Item = &OutboxItem<T>> {
        self.order.values().map(|id| &self.items[id.as_str()])
    }

    /// Re-inserts persisted items, keeping their attempt counts and schedule.
    pub fn restore(&mut self, items: impl IntoIterator<Item = OutboxItem<T>>) {
        for mut it in items {
            it.id = it.id.to_ascii_uppercase();
            if self.items.contains_key(&it.id) {
                continue;
            }
            self.seq += 1;
            self.order.insert(self.seq, it.id.clone());
            self.seqs.insert(it.id.clone(), self.seq);
            self.items.insert(it.id.clone(), it);
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> RetryPolicy {
        RetryPolicy { base_backoff_ms: 100, max_backoff_ms: 1_000, max_attempts: Some(4) }
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let p = policy();
        assert_eq!((1..=6).map(|a| p.backoff_ms(a)).collect::<Vec<_>>(), vec![100, 200, 400, 800, 1000, 1000]);
        assert_eq!(p.backoff_ms(200), 1000);
    }

    #[test]
    fn retries_until_acked() {
        let mut q: Outbox<&str> = Outbox::new(policy(), 10);
        assert_eq!(q.enqueue("a", "A", 0, None).0, EnqueueResult::Queued);
        assert_eq!(q.enqueue("A", "dup", 0, None).0, EnqueueResult::Duplicate);
        assert_eq!(q.poll(0).len(), 1);
        assert!(q.poll(50).is_empty()); // backing off
        let again = q.poll(100);
        assert_eq!(again[0].attempts, 2);
        assert_eq!(again[0].next_attempt_ms, 300);
        assert_eq!(q.next_wake_ms(), Some(300));
        assert!(q.ack("a"));
        assert!(!q.ack("a")); // idempotent
        assert!(q.is_empty());
    }

    #[test]
    fn expiry_and_max_attempts() {
        let mut q: Outbox<u32> = Outbox::new(policy(), 10);
        q.enqueue("exp", 1, 0, Some(150));
        q.enqueue("max", 2, 0, None);
        assert_eq!(q.enqueue("late", 3, 200, Some(200)).0, EnqueueResult::Expired);
        let mut t = 0;
        let mut sends = 0;
        while t <= 2_000 {
            sends += q.poll(t).iter().filter(|i| i.id == "MAX").count();
            t += 50;
        }
        assert_eq!(sends, 4);
        let dead = q.expire(2_000);
        let mut why: Vec<_> = dead.iter().map(|(i, w)| (i.id.as_str(), *w)).collect();
        why.sort();
        assert_eq!(why, vec![("EXP", DropReason::Expired), ("MAX", DropReason::MaxAttempts)]);
        assert!(q.is_empty());
    }

    #[test]
    fn nack_and_retry_now() {
        let mut q: Outbox<()> = Outbox::new(policy(), 10);
        q.enqueue("x", (), 0, None);
        q.poll(0);
        assert_eq!(q.nack("x", 10), Some(110));
        assert!(q.poll(100).is_empty());
        assert!(q.retry_now("x", 100));
        assert_eq!(q.poll(100).len(), 1);
        assert_eq!(q.nack("nope", 0), None);
    }

    #[test]
    fn overflow_evicts_oldest_and_order_is_stable() {
        let mut q: Outbox<u8> = Outbox::new(RetryPolicy::default(), 2);
        q.enqueue("b", 1, 0, None);
        q.enqueue("a", 2, 0, None);
        let (r, ev) = q.enqueue("c", 3, 0, None);
        assert_eq!(r, EnqueueResult::Queued);
        assert_eq!(ev.map(|(i, w)| (i.id, w)), Some(("B".into(), DropReason::Overflow)));
        assert_eq!(q.poll(0).iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["A", "C"]);
    }

    #[test]
    fn persistence_roundtrip_and_envelopes() {
        let mut q: Outbox<Envelope> = Outbox::new(RetryPolicy::default(), 10);
        let env = Envelope { expires: Some(10), ..Envelope::new("@a/b", "m").with_id_and_time() };
        assert_eq!(q.enqueue_envelope(&env, 0), Some(EnqueueResult::Queued));
        assert_eq!(q.enqueue_envelope(&Envelope::new("@a/b", "no id"), 0), None);
        q.poll(0);
        let saved: Vec<_> = q.items().cloned().collect();
        let mut r: Outbox<Envelope> = Outbox::new(RetryPolicy::default(), 10);
        r.restore(saved);
        let it = r.get(env.id.as_deref().unwrap()).unwrap();
        assert_eq!((it.attempts, it.expires_ms), (1, Some(10_000)));
        assert_eq!(r.expire(10_000).len(), 1);
    }
}
