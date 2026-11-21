//! Receiver-side dedupe (spec §6).
//!
//! Keeps recently seen ids in an LRU bounded by `capacity` (default 10,000, the spec
//! minimum). A message whose id was seen is dropped; a message whose `expires` has passed is
//! dropped. Ids are case-insensitive (normalized to upper case). When the set is full,
//! entries whose `expires` has passed are evicted first, then the least recently seen.

use std::collections::{BTreeMap, HashMap};

/// Spec minimum LRU size.
pub const DEFAULT_CAPACITY: usize = 10_000;

#[derive(Debug, Clone)]
struct Entry {
    seq: u64,
    expires: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Deduper {
    capacity: usize,
    seq: u64,
    by_id: HashMap<String, Entry>,
    by_seq: BTreeMap<u64, String>,
}

impl Default for Deduper {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl Deduper {
    pub fn new(capacity: usize) -> Self {
        Deduper { capacity: capacity.max(1), seq: 0, by_id: HashMap::new(), by_seq: BTreeMap::new() }
    }

    /// Returns `true` if the message is new and should be delivered.
    /// `expires` and `now_secs` are Unix seconds. A message without an id is always accepted
    /// (the relay assigns ids; edge peers only see messages with ids).
    pub fn accept(&mut self, id: Option<&str>, expires: Option<u64>, now_secs: u64) -> bool {
        if expires.is_some_and(|e| e < now_secs) {
            return false;
        }
        let Some(id) = id else { return true };
        let id = id.to_ascii_uppercase();
        if let Some(e) = self.by_id.get_mut(&id) {
            // Refresh recency on a duplicate.
            self.by_seq.remove(&e.seq);
            self.seq += 1;
            e.seq = self.seq;
            self.by_seq.insert(self.seq, id);
            return false;
        }
        self.seq += 1;
        self.by_seq.insert(self.seq, id.clone());
        self.by_id.insert(id, Entry { seq: self.seq, expires });
        if self.by_id.len() > self.capacity {
            self.prune(now_secs);
        }
        while self.by_id.len() > self.capacity {
            let (_, oldest) = self.by_seq.pop_first().expect("non-empty");
            self.by_id.remove(&oldest);
        }
        true
    }

    /// Convenience for typed envelopes.
    pub fn accept_envelope(&mut self, env: &crate::Envelope, now_secs: u64) -> bool {
        let expires = env.expires.map(|e| e.max(0) as u64);
        self.accept(env.id.as_deref(), expires, now_secs)
    }

    /// Records an id as seen without the expiry check (e.g. our own published messages).
    pub fn mark_seen(&mut self, id: &str, expires: Option<u64>) {
        self.accept(Some(id), expires, 0);
    }

    pub fn has(&self, id: &str) -> bool {
        self.by_id.contains_key(&id.to_ascii_uppercase())
    }

    /// Drops entries whose `expires` is before `now_secs`. Returns how many were removed.
    pub fn prune(&mut self, now_secs: u64) -> usize {
        let expired: Vec<(String, u64)> = self
            .by_id
            .iter()
            .filter(|(_, e)| e.expires.is_some_and(|x| x < now_secs))
            .map(|(k, e)| (k.clone(), e.seq))
            .collect();
        for (k, seq) in &expired {
            self.by_id.remove(k);
            self.by_seq.remove(seq);
        }
        expired.len()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_duplicates_case_insensitively() {
        let mut d = Deduper::default();
        assert!(d.accept(Some("01jd5a2z3k8q9v6x7w4t1r0s2m"), None, 0));
        assert!(!d.accept(Some("01JD5A2Z3K8Q9V6X7W4T1R0S2M"), None, 0));
        assert!(d.has("01jd5a2z3k8q9v6x7w4t1r0s2m"));
        assert!(d.accept(None, None, 0));
        assert!(d.accept(None, None, 0));
        assert_eq!(d.len(), 1);
    }

    #[test]
    fn drops_expired() {
        let mut d = Deduper::default();
        assert!(!d.accept(Some("A"), Some(99), 100));
        assert!(d.accept(Some("A"), Some(100), 100));
        assert!(!d.has("B"));
    }

    #[test]
    fn lru_eviction_refreshes_on_hit() {
        let mut d = Deduper::new(3);
        for id in ["A", "B", "C"] {
            assert!(d.accept(Some(id), None, 0));
        }
        assert!(!d.accept(Some("A"), None, 0)); // A is now most recent
        assert!(d.accept(Some("D"), None, 0)); // evicts B
        assert!(d.has("A") && !d.has("B") && d.has("C") && d.has("D"));
        assert_eq!(d.len(), 3);
    }

    #[test]
    fn expired_evicted_before_lru() {
        let mut d = Deduper::new(3);
        d.accept(Some("A"), None, 0);
        d.accept(Some("B"), Some(10), 0);
        d.accept(Some("C"), None, 0);
        assert!(d.accept(Some("D"), None, 20)); // B expired: evicted instead of A
        assert!(d.has("A") && !d.has("B") && d.has("C") && d.has("D"));
        assert_eq!(d.prune(1000), 0);
    }

    #[test]
    fn default_capacity_holds_10k() {
        let mut d = Deduper::default();
        for i in 0..10_000 {
            assert!(d.accept(Some(&format!("ID{i}")), None, 0));
        }
        assert!(d.has("ID0"));
        assert!(d.accept(Some("ID10000"), None, 0));
        assert!(!d.has("ID0") && d.len() == 10_000);
    }
}
