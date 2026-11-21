//! Delivery plans and policy intersection (PLAN §5).
//!
//! A delivery plan is the ordered list of transports allowed by
//! `account ∩ topic ∩ subscription ∩ token ∩ message` policies, sorted by the route mode:
//!
//! - `any`: cheapest first (then fastest); delivered sequentially, escalating if unacked.
//! - `fast`: fastest first (then cheapest); sequential.
//! - `all`: every allowed transport at once (alarms); ordered fastest first for dispatch.
//! - `cheap`: edge or free (cost 0) transports only; never escalates to paid ones.
//!
//! Costs are integer micro-dollars (µ$). A cost cap bounds the *worst case* of the plan
//! (every step attempted): transports are taken in plan order and any whose cost would push
//! the running total over the cap is skipped.

use std::collections::BTreeSet;

use crate::envelope::Route;
pub use crate::envelope::{RouteMode, Transport};

/// A transport the subscriber can be reached on, with the current estimates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportEstimate {
    pub transport: Transport,
    /// Estimated cost of one delivery attempt, µ$.
    pub cost_usd_micros: u64,
    /// Estimated latency to the device, ms.
    pub latency_ms: u64,
}

impl TransportEstimate {
    pub fn new(transport: Transport, cost_usd_micros: u64, latency_ms: u64) -> Self {
        TransportEstimate { transport, cost_usd_micros, latency_ms }
    }

    /// Free to send: an edge transport or zero estimated cost.
    pub fn is_free(&self) -> bool {
        self.transport.is_edge() || self.cost_usd_micros == 0
    }
}

/// One layer of transport policy (account, topic, subscription, token, or message).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Policy {
    /// `None` = every transport allowed.
    pub allow: Option<BTreeSet<Transport>>,
    pub deny: BTreeSet<Transport>,
    /// Cap on the worst-case cost of one message's plan, µ$. `None` = uncapped.
    pub max_cost_usd_micros: Option<u64>,
}

impl Policy {
    /// The unrestricted policy (identity for [`Policy::intersect`]).
    pub fn unrestricted() -> Self {
        Self::default()
    }

    pub fn allow(ts: impl IntoIterator<Item = Transport>) -> Self {
        Policy { allow: Some(ts.into_iter().collect()), ..Self::default() }
    }

    pub fn deny(ts: impl IntoIterator<Item = Transport>) -> Self {
        Policy { deny: ts.into_iter().collect(), ..Self::default() }
    }

    pub fn max_cost(micros: u64) -> Self {
        Policy { max_cost_usd_micros: Some(micros), ..Self::default() }
    }

    /// The message-level policy from an envelope's `route` block. Unknown transport ids in
    /// `allow` are ignored (so they allow nothing).
    pub fn from_route(route: &Route) -> Self {
        Policy {
            allow: route.allow_list().map(|v| v.into_iter().collect()),
            deny: route.deny_list().into_iter().collect(),
            max_cost_usd_micros: route.max_cost_usd_micros.map(|c| c.max(0) as u64),
        }
    }

    /// Both policies at once: allow lists intersect, deny lists union, the lower cap wins.
    pub fn intersect(&self, other: &Policy) -> Policy {
        let allow = match (&self.allow, &other.allow) {
            (None, None) => None,
            (Some(a), None) | (None, Some(a)) => Some(a.clone()),
            (Some(a), Some(b)) => Some(a.intersection(b).copied().collect()),
        };
        let max_cost_usd_micros = match (self.max_cost_usd_micros, other.max_cost_usd_micros) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        Policy { allow, deny: self.deny.union(&other.deny).copied().collect(), max_cost_usd_micros }
    }

    pub fn permits(&self, t: Transport) -> bool {
        !self.deny.contains(&t) && self.allow.as_ref().is_none_or(|a| a.contains(&t))
    }

    /// The transports this policy permits, in spec order.
    pub fn permitted(&self) -> Vec<Transport> {
        Transport::ALL.into_iter().filter(|t| self.permits(*t)).collect()
    }
}

/// Intersects any number of policy layers
/// (`account ∩ topic ∩ subscription ∩ token ∩ message`).
pub fn intersect_policies<'a>(layers: impl IntoIterator<Item = &'a Policy>) -> Policy {
    layers.into_iter().fold(Policy::unrestricted(), |acc, p| acc.intersect(p))
}

/// How the plan's steps are dispatched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dispatch {
    /// Try step 1; escalate to the next step if no ack arrives.
    Sequential,
    /// Send on every step at once.
    Parallel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryPlan {
    pub mode: RouteMode,
    pub dispatch: Dispatch,
    pub steps: Vec<TransportEstimate>,
    /// Sum of step costs: what to reserve for this delivery.
    pub worst_case_cost_usd_micros: u64,
}

impl DeliveryPlan {
    pub fn transports(&self) -> Vec<Transport> {
        self.steps.iter().map(|s| s.transport).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
}

/// Builds the delivery plan for one subscription.
///
/// `candidates` are the transports the subscriber is reachable on (duplicates: first wins).
/// Ties are broken by spec transport order so plans are deterministic.
pub fn plan(mode: RouteMode, policy: &Policy, candidates: &[TransportEstimate]) -> DeliveryPlan {
    let mut seen = BTreeSet::new();
    let mut steps: Vec<TransportEstimate> = candidates
        .iter()
        .filter(|c| seen.insert(c.transport))
        .filter(|c| policy.permits(c.transport))
        .filter(|c| mode != RouteMode::Cheap || c.is_free())
        .copied()
        .collect();
    let by_cost = |a: &TransportEstimate, b: &TransportEstimate| {
        (a.cost_usd_micros, a.latency_ms, a.transport).cmp(&(b.cost_usd_micros, b.latency_ms, b.transport))
    };
    let by_latency = |a: &TransportEstimate, b: &TransportEstimate| {
        (a.latency_ms, a.cost_usd_micros, a.transport).cmp(&(b.latency_ms, b.cost_usd_micros, b.transport))
    };
    match mode {
        RouteMode::Any | RouteMode::Cheap => steps.sort_by(by_cost),
        RouteMode::Fast => steps.sort_by(by_latency),
        // Select cheapest-first under the cap, then dispatch fastest-first.
        RouteMode::All => steps.sort_by(by_cost),
    }
    let mut total = 0u64;
    steps.retain(|s| {
        let next = total.saturating_add(s.cost_usd_micros);
        if policy.max_cost_usd_micros.is_some_and(|cap| next > cap) {
            false
        } else {
            total = next;
            true
        }
    });
    let dispatch = if mode == RouteMode::All {
        steps.sort_by(by_latency);
        Dispatch::Parallel
    } else {
        Dispatch::Sequential
    };
    DeliveryPlan { mode, dispatch, steps, worst_case_cost_usd_micros: total }
}

/// Plans delivery of an envelope: the message's own `route` block is intersected with the
/// given policy layers. An unknown route mode falls back to `any`.
pub fn plan_for_envelope<'a>(
    env: &crate::Envelope,
    layers: impl IntoIterator<Item = &'a Policy>,
    candidates: &[TransportEstimate],
) -> DeliveryPlan {
    let mut policy = intersect_policies(layers);
    let mut mode = RouteMode::Any;
    if let Some(r) = &env.route {
        policy = policy.intersect(&Policy::from_route(r));
        mode = r.route_mode().unwrap_or_default();
    }
    plan(mode, &policy, candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Transport::*;

    fn candidates() -> Vec<TransportEstimate> {
        vec![
            TransportEstimate::new(Sms, 8_000, 3_000),
            TransportEstimate::new(Voice, 25_000, 15_000),
            TransportEstimate::new(Ws, 0, 50),
            TransportEstimate::new(Apns, 0, 800),
            TransportEstimate::new(Email, 100, 20_000),
            TransportEstimate::new(Ble, 0, 400),
            TransportEstimate::new(Lxmf, 50, 60_000),
        ]
    }

    #[test]
    fn modes() {
        let p = Policy::unrestricted();
        let c = candidates();
        assert_eq!(plan(RouteMode::Any, &p, &c).transports(), vec![Ws, Ble, Apns, Lxmf, Email, Sms, Voice]);
        assert_eq!(plan(RouteMode::Fast, &p, &c).transports(), vec![Ws, Ble, Apns, Sms, Voice, Email, Lxmf]);
        assert_eq!(plan(RouteMode::Cheap, &p, &c).transports(), vec![Ws, Ble, Apns]);
        let all = plan(RouteMode::All, &p, &c);
        assert_eq!(all.dispatch, Dispatch::Parallel);
        assert_eq!(all.steps.len(), c.len());
        assert_eq!(all.worst_case_cost_usd_micros, 33_150);
        assert_eq!(plan(RouteMode::Any, &p, &c).dispatch, Dispatch::Sequential);
    }

    #[test]
    fn cheap_treats_edge_as_free() {
        // An edge transport is free by definition, even if a cost estimate was attached.
        let c = [TransportEstimate::new(Lan, 5, 10), TransportEstimate::new(Webhook, 5, 10)];
        assert_eq!(plan(RouteMode::Cheap, &Policy::unrestricted(), &c).transports(), vec![Lan]);
    }

    #[test]
    fn allow_deny_and_cap() {
        let c = candidates();
        let p = Policy::deny([Ws, Ble]);
        assert_eq!(plan(RouteMode::Any, &p, &c).transports(), vec![Apns, Lxmf, Email, Sms, Voice]);
        let p = Policy::allow([Sms, Voice, Ws]).intersect(&Policy::max_cost(10_000));
        let pl = plan(RouteMode::Any, &p, &c);
        assert_eq!(pl.transports(), vec![Ws, Sms]);
        assert_eq!(pl.worst_case_cost_usd_micros, 8_000);
        // Cap skips an expensive step but keeps cheaper later ones.
        let c2 = [TransportEstimate::new(Sms, 8_000, 1), TransportEstimate::new(Email, 100, 2)];
        assert_eq!(plan(RouteMode::Fast, &Policy::max_cost(8_050), &c2).transports(), vec![Sms]);
        assert_eq!(plan(RouteMode::Fast, &Policy::max_cost(8_000 - 1), &c2).transports(), vec![Email]);
        assert!(plan(RouteMode::Any, &Policy::allow([]), &c).is_empty());
    }

    #[test]
    fn duplicates_first_wins() {
        let c = [TransportEstimate::new(Sms, 1, 1), TransportEstimate::new(Sms, 0, 0)];
        assert_eq!(plan(RouteMode::Any, &Policy::unrestricted(), &c).steps, vec![c[0]]);
    }

    #[test]
    fn intersection() {
        let account = Policy { max_cost_usd_micros: Some(50_000), ..Policy::deny([Voice]) };
        let topic = Policy::allow([Ws, Sms, Voice, Email, Apns]);
        let sub = Policy::allow([Ws, Sms, Voice, Email]);
        let token = Policy::max_cost(20_000);
        let msg = Policy::deny([Email]);
        let p = intersect_policies([&account, &topic, &sub, &token, &msg]);
        assert_eq!(p.permitted(), vec![Ws, Sms]);
        assert_eq!(p.max_cost_usd_micros, Some(20_000));
        assert_eq!(intersect_policies([]), Policy::unrestricted());
        assert_eq!(Policy::unrestricted().permitted().len(), 17);
    }

    #[test]
    fn from_envelope_route() {
        let env = crate::Envelope::from_value(serde_json::json!({
            "topic": "@a/b",
            "route": {"mode": "fast", "max_cost_usd_micros": 20000, "deny": ["sms"], "allow": ["sms", "voice", "ws", "email", "warp"]}
        }))
        .unwrap();
        let pl = plan_for_envelope(&env, [&Policy::deny([Ws])], &candidates());
        assert_eq!(pl.mode, RouteMode::Fast);
        assert_eq!(pl.transports(), vec![Email]); // voice exceeds the cap, ws/sms denied
        let pl = plan_for_envelope(&crate::Envelope::new("@a/b", "x"), [], &candidates());
        assert_eq!(pl.mode, RouteMode::Any);
        assert_eq!(pl.steps.len(), 7);
    }
}
