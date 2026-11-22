//! LAN discovery and gossip framing (spec §11.5).
//!
//! Peers multicast a small JSON beacon to [`GROUP`]:[`PORT`] every few seconds announcing a
//! random node id and their unicast UDP port. Gossip messages ([`super::gossip`]) then go
//! peer to peer over unicast UDP, split into datagrams with the BLE chunk framing
//! ([`super::ble`]) at [`DATAGRAM_DATA`] data bytes each. The platform shim owns the sockets.

use serde::{Deserialize, Serialize};

use super::ble::{self, BleError};

/// IPv4 multicast group for beacons (administratively scoped; 83.69 = "SE").
pub const GROUP: &str = "239.255.83.69";
pub const PORT: u16 = 47353;
/// Data bytes per datagram (under typical 1280-byte path MTUs with IP/UDP headers).
pub const DATAGRAM_DATA: usize = 1200;
/// The chunking MTU whose capacity is [`DATAGRAM_DATA`].
pub const CHUNK_MTU: usize = DATAGRAM_DATA + 9;
/// Forget peers whose beacon hasn't been heard for this long.
pub const PEER_TIMEOUT_MS: u64 = 30_000;
const PROTOCOL: &str = "lan/1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Beacon {
    pub subetha: String,
    /// 16 lowercase hex characters, random per process.
    pub node: String,
    /// Unicast UDP port for gossip.
    pub port: u16,
}

impl Beacon {
    pub fn new(node: &str, port: u16) -> Self {
        Beacon { subetha: PROTOCOL.to_owned(), node: node.to_owned(), port }
    }

    /// Wire bytes (compact JSON, field order as in the spec).
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("beacon serializes")
    }

    /// Parses and validates a beacon; `None` for anything else on the group.
    pub fn parse(bytes: &[u8]) -> Option<Beacon> {
        let b: Beacon = serde_json::from_slice(bytes).ok()?;
        let hex16 = b.node.len() == 16 && b.node.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        (b.subetha == PROTOCOL && hex16 && b.port > 0).then_some(b)
    }
}

/// A random node id for beacons.
pub fn random_node_id() -> String {
    crate::encoding::hex_encode(&crate::random::random_bytes::<8>())
}

/// Splits a gossip message into datagrams. Reassemble with [`ble::Reassembler`] per peer.
pub fn datagrams(seq: u16, payload: &[u8]) -> Result<Vec<Vec<u8>>, BleError> {
    ble::chunk(seq, payload, CHUNK_MTU)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beacon_roundtrip_and_validation() {
        let b = Beacon::new("0123456789abcdef", 5000);
        assert_eq!(String::from_utf8(b.encode()).unwrap(), r#"{"subetha":"lan/1","node":"0123456789abcdef","port":5000}"#);
        assert_eq!(Beacon::parse(&b.encode()), Some(b));
        for bad in [
            r#"{"subetha":"lan/2","node":"0123456789abcdef","port":1}"#,
            r#"{"subetha":"lan/1","node":"0123456789ABCDEF","port":1}"#,
            r#"{"subetha":"lan/1","node":"0123456789abcdef","port":0}"#,
            r#"{"subetha":"lan/1","node":"0123456789abcdef","port":70000}"#,
            "nope",
        ] {
            assert_eq!(Beacon::parse(bad.as_bytes()), None, "{bad}");
        }
        assert_eq!(random_node_id().len(), 16);
    }

    #[test]
    fn datagrams_fit_and_reassemble() {
        let payload: Vec<u8> = (0..3000u32).map(|i| i as u8).collect();
        let d = datagrams(3, &payload).unwrap();
        assert_eq!(d.len(), 3);
        assert!(d.iter().all(|x| x.len() <= DATAGRAM_DATA + ble::CHUNK_HEADER));
        let mut r = ble::Reassembler::new();
        let out = d.iter().rev().filter_map(|c| r.push(c, 0).unwrap()).next();
        assert_eq!(out, Some(payload));
    }
}
