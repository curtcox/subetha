//! Edge transports from `subetha_core::ffi_edge` (spec §11): the audio modem, animated-QR
//! fountain codec, BLE chunking, and the gossip node. The app's platform code moves bytes and
//! samples; these do the rest. The objects lock internally, so any isolate may use them.

use std::sync::Arc;

use flutter_rust_bridge::frb;
use subetha_core::ffi::FfiError;
use subetha_core::ffi_edge as edge;

fn err(e: FfiError) -> anyhow::Error {
    anyhow::anyhow!(e.to_string())
}

/// 48 kHz mono samples for one modem frame (payload ≤ 1024 bytes, about 50 bytes/s).
#[frb(sync)]
pub fn audio_modulate(payload: Vec<u8>) -> anyhow::Result<Vec<f32>> {
    edge::audio_modulate(payload).map_err(err)
}

/// Decodes the first frame in 48 kHz samples, if any.
#[frb(sync)]
pub fn audio_demodulate(samples: Vec<f32>) -> Option<Vec<u8>> {
    edge::audio_demodulate(samples)
}

/// Resamples mono audio (linear interpolation).
#[frb(sync)]
pub fn audio_resample(samples: Vec<f32>, from_rate: u32, to_rate: u32) -> Vec<f32> {
    edge::audio_resample(samples, from_rate, to_rate)
}

/// Splits a gossip message into BLE chunks (spec §11.3) for a negotiated ATT MTU.
#[frb(sync)]
pub fn ble_chunk(seq: u16, payload: Vec<u8>, att_mtu: u32) -> anyhow::Result<Vec<Vec<u8>>> {
    edge::ble_chunk(seq, payload, att_mtu).map_err(err)
}

/// The gossip `deliver` message one-way links (sound, QR) carry for these envelopes.
#[frb(sync)]
pub fn edge_deliver_payload(envelopes_json: Vec<String>) -> anyhow::Result<Vec<u8>> {
    edge::edge_deliver_payload(envelopes_json).map_err(err)
}

/// What the gossip node made of one message from a peer.
pub struct GossipHandled {
    /// Gossip messages (JSON bytes) to send back to the same peer.
    pub replies: Vec<Vec<u8>>,
    /// New envelopes (JSON) on subscribed topics, for the app.
    pub delivered: Vec<String>,
    /// `"<id>:<reason>"` for each rejected envelope.
    pub dropped: Vec<String>,
}

/// A gossip node (spec §11.4). Feed it whatever peers send; send its replies back.
pub struct GossipNode {
    inner: Arc<edge::EdgeGossipNode>,
}

impl GossipNode {
    #[frb(sync)]
    pub fn new(require_signatures: bool) -> GossipNode {
        GossipNode { inner: edge::EdgeGossipNode::new(require_signatures) }
    }

    #[frb(sync)]
    pub fn subscribe(&self, topic: String) {
        self.inner.subscribe(topic)
    }

    #[frb(sync)]
    pub fn unsubscribe(&self, topic: String) {
        self.inner.unsubscribe(topic)
    }

    /// Relays a topic for others without delivering it to the app.
    #[frb(sync)]
    pub fn set_relayable(&self, topic: String, relay: bool) {
        self.inner.set_relayable(topic, relay)
    }

    /// Adds an envelope of ours (or from the relay). False if already held.
    #[frb(sync)]
    pub fn publish(&self, envelope_json: String, now_secs: u64) -> anyhow::Result<bool> {
        self.inner.publish(envelope_json, now_secs).map_err(err)
    }

    /// Our summary message, to send when a peer connects and after publishing.
    #[frb(sync)]
    pub fn summary(&self, now_secs: u64) -> Vec<u8> {
        self.inner.summary(now_secs)
    }

    /// Handles one gossip message from a peer.
    #[frb(sync)]
    pub fn handle(&self, message: Vec<u8>, now_secs: u64) -> anyhow::Result<GossipHandled> {
        let h = self.inner.handle(message, now_secs).map_err(err)?;
        Ok(GossipHandled { replies: h.replies, delivered: h.delivered, dropped: h.dropped })
    }

    #[frb(sync)]
    pub fn has_seen(&self, id: String) -> bool {
        self.inner.has_seen(id)
    }

    #[frb(sync)]
    pub fn prune(&self, now_secs: u64) {
        self.inner.prune(now_secs)
    }

    #[frb(sync)]
    pub fn stored(&self) -> u64 {
        self.inner.stored()
    }
}

/// Reassembles BLE notifications/writes (or LAN datagrams) from one peer.
pub struct ChunkReassembler {
    inner: Arc<edge::EdgeChunkReassembler>,
}

impl ChunkReassembler {
    #[frb(sync)]
    pub fn new() -> ChunkReassembler {
        ChunkReassembler { inner: edge::EdgeChunkReassembler::new() }
    }

    /// Adds a chunk; returns the message once all of its chunks have arrived.
    #[frb(sync)]
    pub fn push(&self, chunk: Vec<u8>, now_ms: u64) -> anyhow::Result<Option<Vec<u8>>> {
        self.inner.push(chunk, now_ms).map_err(err)
    }

    /// Drops partial messages older than `timeout_ms`; returns how many.
    #[frb(sync)]
    pub fn prune(&self, now_ms: u64, timeout_ms: u64) -> u32 {
        self.inner.prune(now_ms, timeout_ms)
    }
}

/// Fountain-coded animated-QR frames (spec §11.2).
pub struct QrEncoder {
    inner: Arc<edge::EdgeQrEncoder>,
}

impl QrEncoder {
    /// `frame_size` includes the 15-byte header; 356 fills a version 12 QR code at ECC L.
    #[frb(sync)]
    pub fn new(payload: Vec<u8>, frame_size: u32) -> anyhow::Result<QrEncoder> {
        Ok(QrEncoder { inner: edge::EdgeQrEncoder::new(payload, frame_size).map_err(err)? })
    }

    #[frb(sync)]
    pub fn source_blocks(&self) -> u32 {
        self.inner.source_blocks()
    }

    #[frb(sync)]
    pub fn frame(&self, seq: u32) -> Vec<u8> {
        self.inner.frame(seq)
    }

    /// Frame `seq` as base45 text for an alphanumeric QR code.
    #[frb(sync)]
    pub fn frame_text(&self, seq: u32) -> String {
        self.inner.frame_text(seq)
    }
}

pub struct QrProgress {
    /// False if the text wasn't a SubEtha frame (other QR codes in view).
    pub accepted: bool,
    pub complete: bool,
    pub known: u32,
    pub total: u32,
}

impl From<edge::EdgeQrProgress> for QrProgress {
    fn from(p: edge::EdgeQrProgress) -> Self {
        QrProgress { accepted: p.accepted, complete: p.complete, known: p.known, total: p.total }
    }
}

/// Collects scanned frames into a payload; switches to a new transfer automatically.
pub struct QrDecoder {
    inner: Arc<edge::EdgeQrDecoder>,
}

impl QrDecoder {
    #[frb(sync)]
    pub fn new() -> QrDecoder {
        QrDecoder { inner: edge::EdgeQrDecoder::new() }
    }

    #[frb(sync)]
    pub fn push_text(&self, text: String) -> QrProgress {
        self.inner.push_text(text).into()
    }

    #[frb(sync)]
    pub fn push_frame(&self, frame: Vec<u8>) -> QrProgress {
        self.inner.push_frame(frame).into()
    }

    #[frb(sync)]
    pub fn result(&self) -> Option<Vec<u8>> {
        self.inner.result()
    }
}

/// Buffers microphone samples at any rate and returns payloads as frames are heard.
pub struct AudioReceiver {
    inner: Arc<edge::EdgeAudioReceiver>,
}

impl AudioReceiver {
    #[frb(sync)]
    pub fn new(sample_rate: u32, window_seconds: f32) -> AudioReceiver {
        AudioReceiver { inner: edge::EdgeAudioReceiver::new(sample_rate, window_seconds) }
    }

    #[frb(sync)]
    pub fn push(&self, samples: Vec<f32>) -> Option<Vec<u8>> {
        self.inner.push(samples)
    }
}
