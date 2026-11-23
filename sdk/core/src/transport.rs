//! Unified pluggable transport interface (PLAN §6).
//!
//! Every relay or edge transport implements one interface (`capabilities`, `send`,
//! `receive`, `cost_estimate`) so routing and delivery code stay transport-agnostic.

use crate::envelope::{Envelope, Transport as TransportKind};
use crate::routing::{DeliveryPlan, Policy, RouteMode, TransportEstimate};

/// Direction(s) supported by a transport module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
    InOut,
}

/// Static capabilities declared by a transport implementation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportCapabilities {
    pub kind: TransportKind,
    pub edge: bool,
    pub direction: Direction,
    /// Maximum payload size in bytes, if bounded.
    pub max_payload_bytes: Option<usize>,
    /// Typical end-to-end delivery latency in milliseconds.
    pub typical_latency_ms: u64,
    /// Whether the transport supports end-to-end encrypted payloads.
    pub supports_e2ee: bool,
}

/// Outcome of a single transport send attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOutcome {
    pub transport: TransportKind,
    pub provider_id: Option<String>,
    pub cost_usd_micros: u64,
}

/// One pluggable transport implementation (PLAN §6).
pub trait TransportModule {
    fn capabilities(&self) -> TransportCapabilities;

    fn send(&mut self, envelope: &Envelope, endpoint: &str) -> Result<SendOutcome, crate::Error>;

    fn receive(&mut self) -> Result<Vec<Envelope>, crate::Error>;

    /// Estimated cost in micro-dollars (µ$) for sending `envelope` to `endpoint`.
    fn cost_estimate(&self, envelope: &Envelope, endpoint: &str) -> u64;

    /// Helper producing a [`TransportEstimate`] for the routing planner.
    fn estimate(&self, envelope: &Envelope, endpoint: &str) -> TransportEstimate {
        let caps = self.capabilities();
        let cost = if caps.edge { 0 } else { self.cost_estimate(envelope, endpoint) };
        TransportEstimate::new(caps.kind, cost, caps.typical_latency_ms)
    }
}

/// Builds a [`DeliveryPlan`] across a slice of registered transport modules.
pub fn plan_with_modules(
    mode: RouteMode,
    policy: &Policy,
    envelope: &Envelope,
    endpoint: &str,
    modules: &[&dyn TransportModule],
) -> DeliveryPlan {
    let candidates: Vec<TransportEstimate> = modules.iter().map(|m| m.estimate(envelope, endpoint)).collect();
    crate::routing::plan(mode, policy, &candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct LoopbackTransport {
        caps: TransportCapabilities,
        cost: u64,
        inbox: Vec<Envelope>,
    }

    impl TransportModule for LoopbackTransport {
        fn capabilities(&self) -> TransportCapabilities {
            self.caps.clone()
        }

        fn send(&mut self, envelope: &Envelope, _endpoint: &str) -> Result<SendOutcome, crate::Error> {
            self.inbox.push(envelope.clone());
            let cost = if self.caps.edge { 0 } else { self.cost };
            Ok(SendOutcome { transport: self.caps.kind, provider_id: None, cost_usd_micros: cost })
        }

        fn receive(&mut self) -> Result<Vec<Envelope>, crate::Error> {
            Ok(std::mem::take(&mut self.inbox))
        }

        fn cost_estimate(&self, _envelope: &Envelope, _endpoint: &str) -> u64 {
            self.cost
        }
    }

    #[test]
    fn transport_module_roundtrip_and_plan() {
        let mut ble = LoopbackTransport {
            caps: TransportCapabilities {
                kind: TransportKind::Ble,
                edge: true,
                direction: Direction::InOut,
                max_payload_bytes: Some(2048),
                typical_latency_ms: 400,
                supports_e2ee: true,
            },
            cost: 999, // ignored because edge == true
            inbox: vec![],
        };
        let sms = LoopbackTransport {
            caps: TransportCapabilities {
                kind: TransportKind::Sms,
                edge: false,
                direction: Direction::InOut,
                max_payload_bytes: Some(1600),
                typical_latency_ms: 3000,
                supports_e2ee: false,
            },
            cost: 15_000,
            inbox: vec![],
        };
        let env = Envelope::new("@alice/door", "opened");
        let plan = plan_with_modules(RouteMode::Any, &Policy::unrestricted(), &env, "ep1", &[&sms, &ble]);
        assert_eq!(plan.transports(), vec![TransportKind::Ble, TransportKind::Sms]);
        assert_eq!(plan.worst_case_cost_usd_micros, 15_000);

        let cheap = plan_with_modules(RouteMode::Cheap, &Policy::unrestricted(), &env, "ep1", &[&sms, &ble]);
        assert_eq!(cheap.transports(), vec![TransportKind::Ble]);
        assert_eq!(cheap.worst_case_cost_usd_micros, 0);

        let out = ble.send(&env, "ep1").unwrap();
        assert_eq!(out.cost_usd_micros, 0);
        assert_eq!(ble.receive().unwrap(), vec![env]);
    }
}
