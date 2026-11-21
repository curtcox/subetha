//! Edge gossip for BLE and LAN (PLAN §5 step 6, spec §6–§7), as a pure state machine.
//!
//! Peers that meet exchange three messages:
//!
//! 1. [`GossipMessage::Summary`]: recent message ids per topic that the sender could forward
//!    (it holds them, they haven't expired, and their `hops` is > 0).
//! 2. [`GossipMessage::Request`]: the ids the receiver hasn't seen, limited to topics it
//!    subscribes to or relays.
//! 3. [`GossipMessage::Deliver`]: the requested envelopes, each with `hops` decremented.
//!
//! Rules: never forward a message with `hops <= 0`; dedupe by id (spec §6); drop expired
//! messages; only accept, store and relay topics this node subscribes to or has marked
//! relayable; drop envelopes whose signature is present but invalid (and, optionally, unsigned
//! ones). Signatures exclude `hops`, so decrementing it keeps them valid, and E2EE means a
//! relaying node never needs the topic key.
//!
//! The node does no I/O: the platform shim moves [`GossipMessage`]s over BLE/LAN (see
//! [`super::ble`] for chunking) and feeds replies back in.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::dedupe::Deduper;
use crate::envelope::Envelope;
use crate::sign::verify_envelope;

/// Hard cap on `hops` accepted from a peer (schema maximum).
pub const MAX_HOPS: i64 = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GossipConfig {
    /// Ids advertised per topic in a summary (most recent first).
    pub summary_limit: usize,
    /// Messages kept per topic for forwarding.
    pub store_limit: usize,
    /// Drop messages without a signature.
    pub require_signatures: bool,
    /// Dedupe LRU size.
    pub dedupe_capacity: usize,
}

impl Default for GossipConfig {
    fn default() -> Self {
        GossipConfig { summary_limit: 64, store_limit: 256, require_signatures: false, dedupe_capacity: 10_000 }
    }
}

/// Wire messages between peers (serde-serializable; JSON over LAN, chunked over BLE).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GossipMessage {
    Summary { topics: BTreeMap<String, Vec<String>> },
    Request { ids: Vec<String> },
    Deliver { envelopes: Vec<Envelope> },
}

/// Why an incoming envelope was dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    NoId,
    NotInterested,
    Duplicate,
    Expired,
    BadHops,
    BadSignature,
    Unsigned,
}

/// Result of handling one message from a peer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Handled {
    /// Messages to send back to the same peer.
    pub replies: Vec<GossipMessage>,
    /// New messages on subscribed topics, for the application.
    pub delivered: Vec<Envelope>,
    /// Envelopes rejected, with the reason (for diagnostics).
    pub dropped: Vec<(Option<String>, DropReason)>,
}

#[derive(Debug, Clone)]
pub struct GossipNode {
    config: GossipConfig,
    subscriptions: BTreeSet<String>,
    relayable: BTreeSet<String>,
    store: BTreeMap<String, Envelope>,
    /// Per topic, ids in arrival order (oldest first).
    recent: BTreeMap<String, VecDeque<String>>,
    dedupe: Deduper,
}

impl Default for GossipNode {
    fn default() -> Self {
        Self::new(GossipConfig::default())
    }
}

impl GossipNode {
    pub fn new(config: GossipConfig) -> Self {
        let dedupe = Deduper::new(config.dedupe_capacity);
        GossipNode {
            config,
            subscriptions: BTreeSet::new(),
            relayable: BTreeSet::new(),
            store: BTreeMap::new(),
            recent: BTreeMap::new(),
            dedupe,
        }
    }

    pub fn subscribe(&mut self, topic: &str) {
        self.subscriptions.insert(topic.to_owned());
    }

    pub fn unsubscribe(&mut self, topic: &str) {
        self.subscriptions.remove(topic);
    }

    /// Marks a topic this node relays for others without delivering it locally.
    pub fn set_relayable(&mut self, topic: &str, relay: bool) {
        if relay {
            self.relayable.insert(topic.to_owned());
        } else {
            self.relayable.remove(topic);
        }
    }

    /// Does this node accept and relay `topic`?
    pub fn interested(&self, topic: &str) -> bool {
        self.subscriptions.contains(topic) || self.relayable.contains(topic)
    }

    pub fn has_seen(&self, id: &str) -> bool {
        self.dedupe.has(id)
    }

    /// A stored message, by id.
    pub fn get(&self, id: &str) -> Option<&Envelope> {
        self.store.get(&id.to_ascii_uppercase())
    }

    /// Originates a message (already signed/encrypted as needed). It must have an id; its
    /// `hops` sets how far it may travel. Returns `false` if it was a duplicate or invalid.
    pub fn publish(&mut self, env: Envelope, now_secs: u64) -> bool {
        let Some(id) = env.id.clone() else { return false };
        if env.is_expired(now_secs) || !self.dedupe.accept_envelope(&env, now_secs) {
            return false;
        }
        self.remember(id, env);
        true
    }

    fn remember(&mut self, id: String, env: Envelope) {
        if env.hops_remaining() <= 0 {
            return; // nothing to forward; the dedupe set still has the id
        }
        let id = id.to_ascii_uppercase();
        let q = self.recent.entry(env.topic.clone()).or_default();
        q.push_back(id.clone());
        while q.len() > self.config.store_limit {
            if let Some(old) = q.pop_front() {
                self.store.remove(&old);
            }
        }
        self.store.insert(id, env);
    }

    fn forwardable(&self, env: &Envelope, now_secs: u64) -> bool {
        env.hops_remaining() > 0 && !env.is_expired(now_secs) && self.interested(&env.topic)
    }

    /// The summary to send to a peer we just met (or periodically).
    pub fn summary(&self, now_secs: u64) -> GossipMessage {
        let mut topics = BTreeMap::new();
        for (topic, ids) in &self.recent {
            let list: Vec<String> = ids
                .iter()
                .rev()
                .filter(|id| self.store.get(*id).is_some_and(|e| self.forwardable(e, now_secs)))
                .take(self.config.summary_limit)
                .cloned()
                .collect();
            if !list.is_empty() {
                topics.insert(topic.clone(), list);
            }
        }
        GossipMessage::Summary { topics }
    }

    /// Handles one message from a peer.
    pub fn handle(&mut self, msg: GossipMessage, now_secs: u64) -> Handled {
        let mut out = Handled::default();
        match msg {
            GossipMessage::Summary { topics } => {
                let ids: Vec<String> = topics
                    .into_iter()
                    .filter(|(t, _)| self.interested(t))
                    .flat_map(|(_, ids)| ids)
                    .filter(|id| !self.dedupe.has(id))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                if !ids.is_empty() {
                    out.replies.push(GossipMessage::Request { ids });
                }
            }
            GossipMessage::Request { ids } => {
                let envelopes: Vec<Envelope> = ids
                    .iter()
                    .filter_map(|id| self.store.get(&id.to_ascii_uppercase()))
                    .filter(|e| self.forwardable(e, now_secs))
                    .map(|e| Envelope { hops: Some(e.hops_remaining() - 1), ..e.clone() })
                    .collect();
                if !envelopes.is_empty() {
                    out.replies.push(GossipMessage::Deliver { envelopes });
                }
            }
            GossipMessage::Deliver { envelopes } => {
                for env in envelopes {
                    match self.check(&env, now_secs) {
                        Err(why) => out.dropped.push((env.id.clone(), why)),
                        Ok(id) => {
                            if self.subscriptions.contains(&env.topic) {
                                out.delivered.push(env.clone());
                            }
                            self.remember(id, env);
                        }
                    }
                }
            }
        }
        out
    }

    /// Validates an incoming envelope and records its id. Returns the id if it is new.
    fn check(&mut self, env: &Envelope, now_secs: u64) -> Result<String, DropReason> {
        let id = env.id.clone().ok_or(DropReason::NoId)?;
        if !self.interested(&env.topic) {
            return Err(DropReason::NotInterested);
        }
        if !(0..=MAX_HOPS).contains(&env.hops_remaining()) {
            return Err(DropReason::BadHops);
        }
        if env.is_expired(now_secs) {
            return Err(DropReason::Expired);
        }
        if self.dedupe.has(&id) {
            return Err(DropReason::Duplicate);
        }
        match &env.sig {
            Some(_) if !verify_envelope(env) => return Err(DropReason::BadSignature),
            None if self.config.require_signatures => return Err(DropReason::Unsigned),
            _ => {}
        }
        self.dedupe.accept_envelope(env, now_secs);
        Ok(id)
    }

    /// Drops expired messages from the forwarding store.
    pub fn prune(&mut self, now_secs: u64) {
        self.store.retain(|_, e| !e.is_expired(now_secs));
        let store = &self.store;
        for q in self.recent.values_mut() {
            q.retain(|id| store.contains_key(id));
        }
        self.recent.retain(|_, q| !q.is_empty());
        self.dedupe.prune(now_secs);
    }

    /// Number of messages held for forwarding.
    pub fn stored(&self) -> usize {
        self.store.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sign::{sign_envelope, DeviceKey};

    const TOPIC: &str = "@alice/doorbell";

    /// In-memory network: nodes plus undirected links. Each round, every node sends its
    /// summary to every neighbour and the resulting request/deliver exchange runs to the end.
    struct Net {
        nodes: Vec<GossipNode>,
        links: Vec<(usize, usize)>,
        inbox: Vec<Vec<Envelope>>,
    }

    impl Net {
        fn new(n: usize, links: &[(usize, usize)]) -> Self {
            Net { nodes: (0..n).map(|_| GossipNode::default()).collect(), links: links.to_vec(), inbox: vec![vec![]; n] }
        }

        fn line(n: usize) -> Self {
            Self::new(n, &(0..n - 1).map(|i| (i, i + 1)).collect::<Vec<_>>())
        }

        fn exchange(&mut self, from: usize, to: usize, now: u64) -> usize {
            let mut queue = vec![(from, to, self.nodes[from].summary(now))];
            let mut delivered = 0;
            while let Some((src, dst, msg)) = queue.pop() {
                let h = self.nodes[dst].handle(msg, now);
                delivered += h.delivered.len();
                self.inbox[dst].extend(h.delivered);
                queue.extend(h.replies.into_iter().map(|r| (dst, src, r)));
            }
            delivered
        }

        /// Runs rounds until nothing new moves. Returns the number of rounds that moved data.
        fn run(&mut self, now: u64) -> usize {
            let mut rounds = 0;
            loop {
                let before: usize = self.nodes.iter().map(|n| n.stored()).sum::<usize>()
                    + self.inbox.iter().map(Vec::len).sum::<usize>();
                for (a, b) in self.links.clone() {
                    self.exchange(a, b, now);
                    self.exchange(b, a, now);
                }
                let after: usize = self.nodes.iter().map(|n| n.stored()).sum::<usize>()
                    + self.inbox.iter().map(Vec::len).sum::<usize>();
                if after == before {
                    return rounds;
                }
                rounds += 1;
                assert!(rounds < 100, "no convergence");
            }
        }

        fn subscribe_all(&mut self, topic: &str) {
            self.nodes.iter_mut().for_each(|n| n.subscribe(topic));
        }
    }

    fn msg(hops: i64) -> Envelope {
        Envelope { hops: Some(hops), ..Envelope::new(TOPIC, "ding").with_id_and_time() }
    }

    #[test]
    fn hops_3_reaches_d_on_a_line() {
        let mut net = Net::line(4); // A-B-C-D
        net.subscribe_all(TOPIC);
        let m = msg(3);
        assert!(net.nodes[0].publish(m.clone(), 0));
        net.run(0);
        let got: Vec<Option<i64>> = net.inbox.iter().map(|v| v.first().and_then(|e| e.hops)).collect();
        assert_eq!(got, vec![None, Some(2), Some(1), Some(0)]);
        assert_eq!(net.inbox[3][0].message, m.message);
        // D got it with hops 0 and so never advertises it.
        assert!(net.nodes[3].has_seen(m.id.as_deref().unwrap()));
        assert_eq!(net.nodes[3].summary(0), GossipMessage::Summary { topics: BTreeMap::new() });
    }

    #[test]
    fn hops_1_does_not_reach_d() {
        let mut net = Net::line(4);
        net.subscribe_all(TOPIC);
        net.nodes[0].publish(msg(1), 0);
        net.run(0);
        let counts: Vec<usize> = net.inbox.iter().map(Vec::len).collect();
        assert_eq!(counts, vec![0, 1, 0, 0]);
    }

    #[test]
    fn hops_0_never_leaves_origin() {
        let mut net = Net::line(2);
        net.subscribe_all(TOPIC);
        let m = msg(0);
        assert!(net.nodes[0].publish(m.clone(), 0));
        assert_eq!(net.run(0), 0);
        assert!(net.inbox[1].is_empty());
        // Even a direct request is refused.
        let h = net.nodes[0].handle(GossipMessage::Request { ids: vec![m.id.unwrap()] }, 0);
        assert!(h.replies.is_empty());
    }

    #[test]
    fn only_interested_nodes_relay() {
        // B neither subscribes nor relays: the line is cut.
        let mut net = Net::line(3);
        net.nodes[0].subscribe(TOPIC);
        net.nodes[2].subscribe(TOPIC);
        net.nodes[0].publish(msg(5), 0);
        net.run(0);
        assert!(net.inbox[2].is_empty());
        // Marked relayable, B forwards without delivering to its own app.
        net.nodes[1].set_relayable(TOPIC, true);
        net.run(0);
        assert!(net.inbox[1].is_empty());
        assert_eq!(net.inbox[2].len(), 1);
        assert_eq!(net.inbox[2][0].hops, Some(3));
    }

    #[test]
    fn dedupe_across_paths() {
        // Diamond: A-B, A-C, B-D, C-D. D hears the message from both B and C.
        let mut net = Net::new(4, &[(0, 1), (0, 2), (1, 3), (2, 3)]);
        net.subscribe_all(TOPIC);
        net.nodes[0].publish(msg(4), 0);
        net.run(0);
        assert_eq!(net.inbox.iter().map(Vec::len).collect::<Vec<_>>(), vec![0, 1, 1, 1]);
        // A message fed back to its origin is a duplicate.
        let back = net.inbox[1][0].clone();
        let h = net.nodes[0].handle(GossipMessage::Deliver { envelopes: vec![back] }, 0);
        assert_eq!(h.dropped[0].1, DropReason::Duplicate);
    }

    #[test]
    fn signed_messages_survive_hop_decrement_and_forgeries_are_dropped() {
        let key = DeviceKey::generate();
        let signed = sign_envelope(&msg(3), &key).unwrap();
        let mut net = Net::line(4);
        net.subscribe_all(TOPIC);
        for n in &mut net.nodes {
            n.config.require_signatures = true;
        }
        net.nodes[0].publish(signed.clone(), 0);
        net.run(0);
        assert_eq!(net.inbox[3].len(), 1);
        assert!(verify_envelope(&net.inbox[3][0]));

        let mut node = GossipNode::new(GossipConfig { require_signatures: true, ..Default::default() });
        node.subscribe(TOPIC);
        let mut forged = sign_envelope(&msg(3), &key).unwrap();
        forged.message = Some("forged".into());
        let unsigned = msg(3);
        let h = node.handle(GossipMessage::Deliver { envelopes: vec![forged, unsigned] }, 0);
        let why: Vec<DropReason> = h.dropped.iter().map(|d| d.1).collect();
        assert_eq!(why, vec![DropReason::BadSignature, DropReason::Unsigned]);
        assert!(h.delivered.is_empty());
    }

    #[test]
    fn rejects_expired_bad_hops_and_unwanted() {
        let mut node = GossipNode::default();
        node.subscribe(TOPIC);
        let expired = Envelope { expires: Some(10), ..msg(2) };
        let too_many = msg(17);
        let no_id = Envelope { id: None, ..msg(2) };
        let other = Envelope::new("@bob/x", "y").with_id_and_time();
        let h = node.handle(GossipMessage::Deliver { envelopes: vec![expired.clone(), too_many, no_id, other] }, 20);
        let why: Vec<DropReason> = h.dropped.iter().map(|d| d.1).collect();
        assert_eq!(why, vec![DropReason::Expired, DropReason::BadHops, DropReason::NoId, DropReason::NotInterested]);
        assert!(!node.publish(expired, 20));
    }

    #[test]
    fn expiry_prunes_store_and_summary() {
        let mut node = GossipNode::default();
        node.subscribe(TOPIC);
        node.publish(Envelope { expires: Some(100), ..msg(2) }, 0);
        node.publish(msg(2), 0);
        let GossipMessage::Summary { topics } = node.summary(50) else { unreachable!() };
        assert_eq!(topics[TOPIC].len(), 2);
        let GossipMessage::Summary { topics } = node.summary(200) else { unreachable!() };
        assert_eq!(topics[TOPIC].len(), 1);
        node.prune(200);
        assert_eq!(node.stored(), 1);
    }

    #[test]
    fn store_limit_and_wire_format() {
        let mut node = GossipNode::new(GossipConfig { store_limit: 2, summary_limit: 1, ..Default::default() });
        node.subscribe(TOPIC);
        let ms: Vec<Envelope> = (0..3).map(|_| msg(1)).collect();
        for m in &ms {
            node.publish(m.clone(), 0);
        }
        assert_eq!(node.stored(), 2);
        assert!(node.get(ms[0].id.as_deref().unwrap()).is_none());
        let s = node.summary(0);
        let GossipMessage::Summary { topics } = &s else { unreachable!() };
        assert_eq!(topics[TOPIC], vec![ms[2].id.clone().unwrap()]);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.starts_with(r#"{"type":"summary""#), "{json}");
        assert_eq!(serde_json::from_str::<GossipMessage>(&json).unwrap(), s);
    }
}
