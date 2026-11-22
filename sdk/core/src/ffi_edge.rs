//! Binding-friendly edge transports (spec §11): stateless helpers plus stateful objects
//! (`uniffi::Object`, each a `Mutex` around the core type) that native platform shims drive
//! with radio chunks, microphone samples, camera strings, and timers. Envelopes and gossip
//! messages cross the boundary as JSON (text or UTF-8 bytes). See `BINDINGS.md`.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::edge::gossip::{DropReason, GossipConfig, GossipMessage, GossipNode};
use crate::edge::{audio, ble, lan, qr};
use crate::encoding::{base45_decode, base45_encode};
use crate::ffi::FfiError;
use crate::Envelope;

fn fail(msg: impl Into<String>) -> FfiError {
    FfiError::Failed { msg: msg.into() }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- stateless helpers ----

/// 48 kHz mono PCM for one modem frame (≤ 1024 bytes).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn audio_modulate(payload: Vec<u8>) -> Result<Vec<f32>, FfiError> {
    if payload.len() > audio::MAX_PAYLOAD {
        return Err(fail("audio payload too large"));
    }
    Ok(audio::modulate(&payload))
}

/// The first valid frame in 48 kHz mono PCM, if any.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn audio_demodulate(samples: Vec<f32>) -> Option<Vec<u8>> {
    audio::demodulate(&samples)
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn audio_resample(samples: Vec<f32>, from_rate: u32, to_rate: u32) -> Vec<f32> {
    audio::resample(&samples, from_rate, to_rate)
}

/// Splits a message into BLE chunks for a negotiated ATT MTU (spec §11.3).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn ble_chunk(seq: u16, payload: Vec<u8>, att_mtu: u32) -> Result<Vec<Vec<u8>>, FfiError> {
    ble::chunk(seq, &payload, att_mtu as usize).map_err(|e| fail(e.to_string()))
}

/// The payload one-way links (audio, QR) carry: a gossip `deliver` message (spec §11.4).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn edge_deliver_payload(envelopes_json: Vec<String>) -> Result<Vec<u8>, FfiError> {
    let envelopes = envelopes_json.iter().map(|j| Envelope::from_json(j)).collect::<Result<Vec<_>, _>>()?;
    Ok(serde_json::to_vec(&GossipMessage::Deliver { envelopes }).expect("serializes"))
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn base45_encode_bytes(bytes: Vec<u8>) -> String {
    base45_encode(&bytes)
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn base45_decode_text(text: String) -> Result<Vec<u8>, FfiError> {
    Ok(base45_decode(&text)?)
}

/// LAN beacon bytes (spec §11.5) for this node and unicast port.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn lan_beacon(node: String, port: u16) -> Vec<u8> {
    lan::Beacon::new(&node, port).encode()
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct LanBeaconRecord {
    pub node: String,
    pub port: u16,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn lan_parse_beacon(bytes: Vec<u8>) -> Option<LanBeaconRecord> {
    lan::Beacon::parse(&bytes).map(|b| LanBeaconRecord { node: b.node, port: b.port })
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn lan_new_node_id() -> String {
    lan::random_node_id()
}

/// Splits a gossip message into LAN datagrams (reassemble with `EdgeChunkReassembler`).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn lan_datagrams(seq: u16, payload: Vec<u8>) -> Result<Vec<Vec<u8>>, FfiError> {
    lan::datagrams(seq, &payload).map_err(|e| fail(e.to_string()))
}

// ---- gossip node ----

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EdgeHandledRecord {
    /// Gossip messages (JSON bytes) to send back to the same peer.
    pub replies: Vec<Vec<u8>>,
    /// New envelopes (JSON) on subscribed topics, for the app.
    pub delivered: Vec<String>,
    /// `"<id>:<reason>"` for each rejected envelope (reasons as in the TS SDK).
    pub dropped: Vec<String>,
}

fn reason(r: DropReason) -> &'static str {
    match r {
        DropReason::NoId => "no_id",
        DropReason::NotInterested => "not_interested",
        DropReason::Duplicate => "duplicate",
        DropReason::Expired => "expired",
        DropReason::BadHops => "bad_hops",
        DropReason::BadSignature => "bad_signature",
        DropReason::Unsigned => "unsigned",
    }
}

/// A gossip node (spec §11.4). Feed it whatever peers send; send its replies back.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct EdgeGossipNode {
    inner: Mutex<GossipNode>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl EdgeGossipNode {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(require_signatures: bool) -> Arc<Self> {
        Arc::new(EdgeGossipNode { inner: Mutex::new(GossipNode::new(GossipConfig { require_signatures, ..GossipConfig::default() })) })
    }

    pub fn subscribe(&self, topic: String) {
        lock(&self.inner).subscribe(&topic);
    }

    pub fn unsubscribe(&self, topic: String) {
        lock(&self.inner).unsubscribe(&topic);
    }

    /// Relay `topic` for others without delivering it locally.
    pub fn set_relayable(&self, topic: String, relay: bool) {
        lock(&self.inner).set_relayable(&topic, relay);
    }

    /// Originates a message (sign/encrypt it first; it needs an id). False if duplicate or expired.
    pub fn publish(&self, envelope_json: String, now_secs: u64) -> Result<bool, FfiError> {
        let env = Envelope::from_json(&envelope_json)?;
        Ok(lock(&self.inner).publish(env, now_secs))
    }

    /// Our summary (JSON bytes), sent to a peer on meeting it and after publishing.
    pub fn summary(&self, now_secs: u64) -> Vec<u8> {
        serde_json::to_vec(&lock(&self.inner).summary(now_secs)).expect("serializes")
    }

    /// Handles one gossip message (JSON bytes) from a peer.
    pub fn handle(&self, message: Vec<u8>, now_secs: u64) -> Result<EdgeHandledRecord, FfiError> {
        let msg: GossipMessage = serde_json::from_slice(&message).map_err(|e| fail(format!("bad gossip message: {e}")))?;
        let h = lock(&self.inner).handle(msg, now_secs);
        Ok(EdgeHandledRecord {
            replies: h.replies.iter().map(|r| serde_json::to_vec(r).expect("serializes")).collect(),
            delivered: h.delivered.iter().map(Envelope::to_json).collect(),
            dropped: h.dropped.iter().map(|(id, r)| format!("{}:{}", id.as_deref().unwrap_or(""), reason(*r))).collect(),
        })
    }

    pub fn has_seen(&self, id: String) -> bool {
        lock(&self.inner).has_seen(&id)
    }

    /// Drops expired messages; call every few minutes.
    pub fn prune(&self, now_secs: u64) {
        lock(&self.inner).prune(now_secs);
    }

    pub fn stored(&self) -> u64 {
        lock(&self.inner).stored() as u64
    }
}

// ---- BLE / LAN chunk reassembly ----

/// Reassembles chunks from one peer connection (BLE notifications/writes or LAN datagrams).
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct EdgeChunkReassembler {
    inner: Mutex<ble::Reassembler>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl EdgeChunkReassembler {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new() -> Arc<Self> {
        Arc::new(EdgeChunkReassembler { inner: Mutex::new(ble::Reassembler::new()) })
    }

    /// Adds a chunk; returns the message once all its chunks arrived. Throws on a bad chunk.
    pub fn push(&self, chunk: Vec<u8>, now_ms: u64) -> Result<Option<Vec<u8>>, FfiError> {
        lock(&self.inner).push(&chunk, now_ms).map_err(|e| fail(e.to_string()))
    }

    /// Drops partial messages older than `timeout_ms`; returns how many.
    pub fn prune(&self, now_ms: u64, timeout_ms: u64) -> u32 {
        lock(&self.inner).prune(now_ms, timeout_ms) as u32
    }
}

// ---- animated QR ----

/// Endless fountain-coded frame stream (spec §11.2) for one payload.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct EdgeQrEncoder {
    inner: qr::Encoder,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl EdgeQrEncoder {
    /// `frame_size` includes the 15-byte header. For a QR symbol holding C alphanumeric
    /// characters, use floor(C / 3) * 2 (base45 text).
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(payload: Vec<u8>, frame_size: u32) -> Result<Arc<Self>, FfiError> {
        let inner = qr::encode(&payload, frame_size as usize).map_err(|e| fail(e.to_string()))?;
        Ok(Arc::new(EdgeQrEncoder { inner }))
    }

    pub fn source_blocks(&self) -> u32 {
        self.inner.source_blocks() as u32
    }

    pub fn frame(&self, seq: u32) -> Vec<u8> {
        self.inner.frame(seq)
    }

    /// Frame `seq` as base45 text for an alphanumeric-mode QR code.
    pub fn frame_text(&self, seq: u32) -> String {
        base45_encode(&self.inner.frame(seq))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EdgeQrProgress {
    /// False if the text wasn't a SubEtha frame (other QR codes in view).
    pub accepted: bool,
    pub complete: bool,
    pub known: u32,
    pub total: u32,
}

/// Collects scanned frames into a payload; switches to a new transfer automatically.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct EdgeQrDecoder {
    inner: Mutex<qr::Decoder>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl EdgeQrDecoder {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new() -> Arc<Self> {
        Arc::new(EdgeQrDecoder { inner: Mutex::new(qr::Decoder::new()) })
    }

    /// Feeds one scanned string (base45 text).
    pub fn push_text(&self, text: String) -> EdgeQrProgress {
        match base45_decode(text.trim()) {
            Ok(frame) => self.push_frame(frame),
            Err(_) => EdgeQrProgress { accepted: false, complete: false, known: 0, total: 0 },
        }
    }

    /// Feeds one frame (for scanners that return raw bytes).
    pub fn push_frame(&self, frame: Vec<u8>) -> EdgeQrProgress {
        let mut d = lock(&self.inner);
        let r = match d.push(&frame) {
            Err(qr::QrError::Mismatch) => {
                d.reset();
                d.push(&frame)
            }
            other => other,
        };
        match r {
            Ok(qr::Progress::Complete) => EdgeQrProgress { accepted: true, complete: true, known: 0, total: 0 },
            Ok(qr::Progress::Partial { known, total }) => EdgeQrProgress { accepted: true, complete: false, known: known as u32, total: total as u32 },
            Err(_) => EdgeQrProgress { accepted: false, complete: false, known: 0, total: 0 },
        }
    }

    pub fn result(&self) -> Option<Vec<u8>> {
        lock(&self.inner).result().map(<[u8]>::to_vec)
    }
}

// ---- audio ----

/// Buffers microphone samples at any rate and returns payloads as frames are heard.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct EdgeAudioReceiver {
    inner: Mutex<audio::Receiver>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl EdgeAudioReceiver {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(sample_rate: u32, window_seconds: f32) -> Arc<Self> {
        Arc::new(EdgeAudioReceiver { inner: Mutex::new(audio::Receiver::new(sample_rate, window_seconds, 0.5)) })
    }

    pub fn push(&self, samples: Vec<f32>) -> Option<Vec<u8>> {
        lock(&self.inner).push(&samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffi::{device_key_from_seed, sign_envelope_json};

    const TOPIC: &str = "@alice/doorbell";

    fn signed(msg: &str, hops: i64) -> String {
        let seed = device_key_from_seed(vec![7; 32]).unwrap().seed;
        let env = serde_json::json!({ "id": crate::ulid::ulid(), "time": 1_763_750_000, "topic": TOPIC, "message": msg, "hops": hops });
        sign_envelope_json(env.to_string(), seed).unwrap()
    }

    #[test]
    fn gossip_nodes_exchange_over_ble_chunks() {
        let a = EdgeGossipNode::new(true);
        let b = EdgeGossipNode::new(true);
        a.subscribe(TOPIC.into());
        b.subscribe(TOPIC.into());
        assert!(a.publish(signed("ding", 2), 1_763_750_000).unwrap());
        let ra = EdgeChunkReassembler::new();
        let rb = EdgeChunkReassembler::new();
        // a → b summary, b → a request, a → b deliver; every message chunked at MTU 23.
        let mut queue = vec![(true, a.summary(1_763_750_000))];
        let mut delivered = vec![];
        let mut seq = 0u16;
        while let Some((to_b, msg)) = queue.pop() {
            let (node, reasm) = if to_b { (&b, &rb) } else { (&a, &ra) };
            let mut whole = None;
            for c in ble_chunk(seq, msg, 23).unwrap() {
                whole = reasm.push(c, 0).unwrap().or(whole);
            }
            seq += 1;
            let h = node.handle(whole.unwrap(), 1_763_750_000).unwrap();
            delivered.extend(h.delivered);
            queue.extend(h.replies.into_iter().map(|r| (!to_b, r)));
        }
        assert_eq!(delivered.len(), 1);
        let env: serde_json::Value = serde_json::from_str(&delivered[0]).unwrap();
        assert_eq!(env["message"], "ding");
        assert_eq!(env["hops"], 1);
        assert_eq!(b.stored(), 1);
        assert!(b.handle(b"not json".to_vec(), 0).is_err());
        let h = b.handle(edge_deliver_payload(vec![signed("x", 1).replace("\"x\"", "\"forged\"")]).unwrap(), 1_763_750_000).unwrap();
        assert!(h.dropped[0].ends_with(":bad_signature"), "{:?}", h.dropped);
    }

    #[test]
    fn qr_and_audio_objects_roundtrip() {
        let payload = edge_deliver_payload(vec![signed("over the air", 1)]).unwrap();
        let enc = EdgeQrEncoder::new(payload.clone(), 100).unwrap();
        let dec = EdgeQrDecoder::new();
        assert!(!dec.push_text("https://example.com".into()).accepted);
        let mut seq = 2;
        while !dec.push_text(enc.frame_text(seq)).complete {
            seq += 3;
        }
        assert_eq!(dec.result(), Some(payload.clone()));
        // A new transfer replaces the old one.
        let other = EdgeQrEncoder::new(b"second".to_vec(), 100).unwrap();
        assert!(dec.push_frame(other.frame(0)).complete);
        assert_eq!(dec.result(), Some(b"second".to_vec()));

        let pcm = audio_modulate(b"wake".to_vec()).unwrap();
        assert_eq!(audio_demodulate(pcm.clone()), Some(b"wake".to_vec()));
        let rx = EdgeAudioReceiver::new(16_000, 3.0);
        let at16 = audio_resample(pcm, 48_000, 16_000);
        let mut stream = at16.clone();
        stream.extend(vec![0.0; 16_000]);
        let got: Vec<Vec<u8>> = stream.chunks(1024).filter_map(|c| rx.push(c.to_vec())).collect();
        assert_eq!(got, vec![b"wake".to_vec()]);
        assert!(audio_modulate(vec![0; 2000]).is_err());
    }

    #[test]
    fn lan_and_base45_helpers() {
        let id = lan_new_node_id();
        let b = lan_beacon(id.clone(), 4000);
        assert_eq!(lan_parse_beacon(b), Some(LanBeaconRecord { node: id, port: 4000 }));
        assert_eq!(lan_parse_beacon(b"x".to_vec()), None);
        assert_eq!(lan_datagrams(1, vec![0; 2500]).unwrap().len(), 3);
        assert_eq!(base45_decode_text(base45_encode_bytes(b"AB".to_vec())).unwrap(), b"AB");
        assert!(base45_decode_text("a".into()).is_err());
    }
}
