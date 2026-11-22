import Foundation
import SubEtha
import SubEthaCoreFFI

// Edge transports through the Rust core (spec §11): sound, animated QR, Bluetooth LE, LAN.
// The app's platform shim moves bytes (CoreBluetooth, AVAudioEngine, AVCaptureSession,
// Network.framework) and drives these objects. Envelopes and gossip messages are JSON.

/// Gossip node (spec §11.4): feed it what peers send, send its replies back.
public typealias EdgeGossipNode = SubEthaCoreFFI.EdgeGossipNode
public typealias EdgeHandledRecord = SubEthaCoreFFI.EdgeHandledRecord
/// Reassembles BLE notifications/writes or LAN datagrams from one peer.
public typealias EdgeChunkReassembler = SubEthaCoreFFI.EdgeChunkReassembler
/// Fountain-coded animated-QR frames; show `frameText(seq:)` as alphanumeric QR codes.
public typealias EdgeQrEncoder = SubEthaCoreFFI.EdgeQrEncoder
public typealias EdgeQrDecoder = SubEthaCoreFFI.EdgeQrDecoder
public typealias EdgeQrProgress = SubEthaCoreFFI.EdgeQrProgress
/// Microphone samples (any rate) in, payloads out.
public typealias EdgeAudioReceiver = SubEthaCoreFFI.EdgeAudioReceiver

/// Store-and-forward outbox for offline publishing (persist `toJson()`, `restoreJson(json:)`).
public typealias CoreOutbox = SubEthaCoreFFI.CoreOutbox
public typealias OutboxItemRecord = SubEthaCoreFFI.OutboxItemRecord
/// Receiver dedupe across transports (spec §6).
public typealias CoreDeduper = SubEthaCoreFFI.CoreDeduper

public enum Edge {
    /// SubEtha's GATT service and characteristics (spec §11.3).
    public static let serviceUUID = "53554245-5448-4100-8000-5ebe7a000000"
    public static let inboxUUID = "53554245-5448-4100-8000-5ebe7a000001"
    public static let outboxUUID = "53554245-5448-4100-8000-5ebe7a000002"
    public static let lanGroup = "239.255.83.69"
    public static let lanPort: UInt16 = 47353

    /// What one-way links (sound, QR) carry: a gossip `deliver` message.
    public static func deliverPayload(_ envelopesJSON: [String]) throws -> Data {
        try SubEthaCoreFFI.edgeDeliverPayload(envelopesJson: envelopesJSON)
    }

    /// 48 kHz mono PCM for one modem frame (≤ 1024 bytes, 50 bytes/s).
    public static func modulate(_ payload: Data) throws -> [Float] {
        try SubEthaCoreFFI.audioModulate(payload: payload)
    }

    public static func demodulate(_ samples48k: [Float]) -> Data? {
        SubEthaCoreFFI.audioDemodulate(samples: samples48k)
    }

    /// Chunks for one BLE write/notification each, at a negotiated ATT MTU.
    public static func bleChunks(seq: UInt16, _ payload: Data, attMtu: UInt32 = 185) throws -> [Data] {
        try SubEthaCoreFFI.bleChunk(seq: seq, payload: payload, attMtu: attMtu)
    }

    public static func lanBeacon(node: String, port: UInt16) -> Data {
        SubEthaCoreFFI.lanBeacon(node: node, port: port)
    }

    public static func lanDatagrams(seq: UInt16, _ payload: Data) throws -> [Data] {
        try SubEthaCoreFFI.lanDatagrams(seq: seq, payload: payload)
    }

    public static func newLanNodeId() -> String { SubEthaCoreFFI.lanNewNodeId() }
}
