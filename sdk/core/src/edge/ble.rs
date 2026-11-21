//! Bluetooth LE: GATT identifiers and MTU-sized chunking for gossip messages.
//!
//! GATT layout (one primary service, advertised so peers can find each other):
//!
//! | UUID | Characteristic | Properties | Carries |
//! |---|---|---|---|
//! | [`SERVICE_UUID`] | SubEtha service | — | — |
//! | [`INBOX_UUID`] | inbox | write, write-without-response | chunks from the central to us |
//! | [`OUTBOX_UUID`] | outbox | notify, indicate | chunks from us to the central |
//! | [`SUMMARY_UUID`] | summary | read | a compact gossip summary, for quick peeks |
//! | [`VERSION_UUID`] | protocol version | read | `[PROTOCOL_VERSION]` |
//!
//! UUIDs are random version-4 UUIDs whose first bytes spell `SUBETHA` (0x53 0x55 0x42 0x45
//! 0x54 0x48 0x41).
//!
//! Chunk layout (big-endian), one chunk per ATT write/notification:
//!
//! ```text
//! 0  u16  message sequence number (per connection, wraps)
//! 2  u16  chunk index
//! 4  u16  chunk count
//! 6  ...  data
//! ```
//!
//! The message is `payload || CRC-16/CCITT-FALSE(payload)`, split into chunks of at most
//! `ATT_MTU - 3 - 6` data bytes (the ATT header takes 3 bytes of the negotiated MTU).

use std::collections::BTreeMap;

use crate::crc::crc16_ccitt;

pub const SERVICE_UUID: &str = "53554245-5448-4100-8000-5ebe7a000000";
pub const INBOX_UUID: &str = "53554245-5448-4100-8000-5ebe7a000001";
pub const OUTBOX_UUID: &str = "53554245-5448-4100-8000-5ebe7a000002";
pub const SUMMARY_UUID: &str = "53554245-5448-4100-8000-5ebe7a000003";
pub const VERSION_UUID: &str = "53554245-5448-4100-8000-5ebe7a000004";
pub const PROTOCOL_VERSION: u8 = 1;

/// Default ATT MTU before negotiation (BLE 4.0).
pub const DEFAULT_ATT_MTU: usize = 23;
/// Largest ATT MTU (BLE 4.2+ with DLE; also the attribute value limit + header).
pub const MAX_ATT_MTU: usize = 517;
const ATT_HEADER: usize = 3;
pub const CHUNK_HEADER: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BleError {
    #[error("ATT MTU {0} is too small")]
    MtuTooSmall(usize),
    #[error("message needs more than 65535 chunks")]
    TooLarge,
    #[error("malformed chunk")]
    Malformed,
    #[error("chunk disagrees with earlier chunks of the same message")]
    Inconsistent,
    #[error("reassembled message failed its CRC")]
    BadCrc,
}

/// Parses a 128-bit UUID string into bytes (big-endian, as on the wire in UUID order).
pub fn uuid_bytes(uuid: &str) -> Option<[u8; 16]> {
    let hex: String = uuid.chars().filter(|c| *c != '-').collect();
    let v = crate::encoding::hex_decode(&hex).ok()?;
    v.try_into().ok()
}

/// Data bytes per chunk for a negotiated ATT MTU.
pub fn chunk_capacity(att_mtu: usize) -> Result<usize, BleError> {
    att_mtu.checked_sub(ATT_HEADER + CHUNK_HEADER).filter(|c| *c > 0).ok_or(BleError::MtuTooSmall(att_mtu))
}

/// Splits `payload` into chunks for one ATT MTU.
pub fn chunk(seq: u16, payload: &[u8], att_mtu: usize) -> Result<Vec<Vec<u8>>, BleError> {
    let cap = chunk_capacity(att_mtu)?;
    let mut msg = payload.to_vec();
    msg.extend_from_slice(&crc16_ccitt(payload).to_be_bytes());
    let count = msg.len().div_ceil(cap);
    let count16 = u16::try_from(count).map_err(|_| BleError::TooLarge)?;
    Ok(msg
        .chunks(cap)
        .enumerate()
        .map(|(i, data)| {
            let mut c = Vec::with_capacity(CHUNK_HEADER + data.len());
            c.extend_from_slice(&seq.to_be_bytes());
            c.extend_from_slice(&(i as u16).to_be_bytes());
            c.extend_from_slice(&count16.to_be_bytes());
            c.extend_from_slice(data);
            c
        })
        .collect())
}

#[derive(Debug, Clone)]
struct Partial {
    count: u16,
    parts: BTreeMap<u16, Vec<u8>>,
    started_ms: u64,
}

/// Reassembles chunks from one peer connection. Chunks may arrive out of order or twice;
/// several messages may be interleaved (distinguished by sequence number).
#[derive(Debug, Clone, Default)]
pub struct Reassembler {
    partial: BTreeMap<u16, Partial>,
}

impl Reassembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a chunk. Returns the payload once every chunk of its message has arrived.
    pub fn push(&mut self, chunk: &[u8], now_ms: u64) -> Result<Option<Vec<u8>>, BleError> {
        if chunk.len() < CHUNK_HEADER {
            return Err(BleError::Malformed);
        }
        let seq = u16::from_be_bytes([chunk[0], chunk[1]]);
        let index = u16::from_be_bytes([chunk[2], chunk[3]]);
        let count = u16::from_be_bytes([chunk[4], chunk[5]]);
        if count == 0 || index >= count {
            return Err(BleError::Malformed);
        }
        let p = self.partial.entry(seq).or_insert_with(|| Partial { count, parts: BTreeMap::new(), started_ms: now_ms });
        if p.count != count {
            self.partial.remove(&seq);
            return Err(BleError::Inconsistent);
        }
        p.parts.entry(index).or_insert_with(|| chunk[CHUNK_HEADER..].to_vec());
        if p.parts.len() < usize::from(count) {
            return Ok(None);
        }
        let p = self.partial.remove(&seq).expect("present");
        let mut msg: Vec<u8> = p.parts.into_values().flatten().collect();
        if msg.len() < 2 {
            return Err(BleError::Malformed);
        }
        let crc = msg.split_off(msg.len() - 2);
        if crc16_ccitt(&msg).to_be_bytes() != crc[..] {
            return Err(BleError::BadCrc);
        }
        Ok(Some(msg))
    }

    /// Drops messages that started more than `timeout_ms` ago. Returns how many.
    pub fn prune(&mut self, now_ms: u64, timeout_ms: u64) -> usize {
        let before = self.partial.len();
        self.partial.retain(|_, p| now_ms.saturating_sub(p.started_ms) <= timeout_ms);
        before - self.partial.len()
    }

    /// Messages still waiting for chunks.
    pub fn pending(&self) -> usize {
        self.partial.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_valid_v4_and_distinct() {
        let all = [SERVICE_UUID, INBOX_UUID, OUTBOX_UUID, SUMMARY_UUID, VERSION_UUID];
        for u in all {
            let b = uuid_bytes(u).unwrap();
            assert_eq!(b[6] >> 4, 4, "{u} version");
            assert_eq!(b[8] >> 6, 0b10, "{u} variant");
            assert_eq!(&b[..7], b"SUBETHA");
            assert_eq!(u.len(), 36);
        }
        let set: std::collections::BTreeSet<_> = all.iter().collect();
        assert_eq!(set.len(), all.len());
        assert_eq!(uuid_bytes("nope"), None);
    }

    #[test]
    fn roundtrip_default_and_large_mtu() {
        let payload: Vec<u8> = (0..1000u32).map(|i| (i * 7) as u8).collect();
        for mtu in [DEFAULT_ATT_MTU, 185, MAX_ATT_MTU] {
            let chunks = chunk(9, &payload, mtu).unwrap();
            assert!(chunks.iter().all(|c| c.len() <= mtu - 3));
            assert_eq!(chunks.len(), (payload.len() + 2).div_ceil(mtu - 9));
            let mut r = Reassembler::new();
            let mut out = None;
            for c in &chunks {
                out = r.push(c, 0).unwrap();
            }
            assert_eq!(out, Some(payload.clone()));
            assert_eq!(r.pending(), 0);
        }
        assert_eq!(chunk(0, b"", 23).unwrap().len(), 1);
    }

    #[test]
    fn out_of_order_duplicates_and_interleaving() {
        let a = chunk(1, b"the quick brown fox jumps over the lazy dog", 23).unwrap();
        let b = chunk(2, b"pack my box with five dozen liquor jugs", 23).unwrap();
        let mut r = Reassembler::new();
        let mut got = vec![];
        let mut order: Vec<&Vec<u8>> = a.iter().rev().chain(b.iter()).collect();
        order.insert(2, &a[0]); // duplicate
        order.swap(1, 5);
        for c in order {
            if let Some(m) = r.push(c, 0).unwrap() {
                got.push(m);
            }
        }
        got.sort();
        assert_eq!(got, vec![b"pack my box with five dozen liquor jugs".to_vec(), b"the quick brown fox jumps over the lazy dog".to_vec()]);
    }

    #[test]
    fn errors() {
        assert_eq!(chunk(0, b"x", 9), Err(BleError::MtuTooSmall(9)));
        assert!(chunk(0, &vec![0; 70_000], 10).is_err());
        let mut r = Reassembler::new();
        assert_eq!(r.push(&[0, 0, 0], 0), Err(BleError::Malformed));
        assert_eq!(r.push(&[0, 0, 0, 1, 0, 1], 0), Err(BleError::Malformed)); // index >= count
        let mut c = chunk(3, b"hello", 23).unwrap();
        let last = c[0].len() - 3;
        c[0][last] ^= 1;
        assert_eq!(r.push(&c[0], 0), Err(BleError::BadCrc));
        let two = chunk(4, &[7; 40], 23).unwrap();
        r.push(&two[0], 0).unwrap();
        let mut bad = two[1].clone();
        bad[5] = 9; // different count
        assert_eq!(r.push(&bad, 0), Err(BleError::Inconsistent));
    }

    #[test]
    fn prune_stale() {
        let two = chunk(5, &[1; 40], 23).unwrap();
        let mut r = Reassembler::new();
        r.push(&two[0], 1_000).unwrap();
        assert_eq!(r.prune(5_000, 10_000), 0);
        assert_eq!(r.prune(20_000, 10_000), 1);
        assert_eq!(r.pending(), 0);
    }

    #[test]
    fn carries_gossip_messages() {
        use super::super::gossip::GossipMessage;
        let env = crate::Envelope::new("@a/b", "over the air").with_id_and_time();
        let msg = GossipMessage::Deliver { envelopes: vec![env] };
        let bytes = serde_json::to_vec(&msg).unwrap();
        let mut r = Reassembler::new();
        let out = chunk(0, &bytes, 185).unwrap().iter().filter_map(|c| r.push(c, 0).unwrap()).next().unwrap();
        assert_eq!(serde_json::from_slice::<GossipMessage>(&out).unwrap(), msg);
    }
}
