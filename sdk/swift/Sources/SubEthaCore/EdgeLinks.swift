import Foundation
import SubEtha
import SubEthaCoreFFI

// Platform-independent drivers for edge transports (spec §11), mirroring sdk/js/src/edge/links.ts
// and bridge.ts (and the Kotlin SDK's Edge.kt). Platform shims (CoreBluetooth, AVAudioEngine)
// only move bytes and samples in and out; these classes do the rest. Not thread-safe: drive each
// one from a single queue or actor.

@usableFromInline
func edgeNowSecs() -> UInt64 { UInt64(Date().timeIntervalSince1970) }

/// The gossip message's `type` and, for `deliver`, how many envelopes it carries.
private func gossipType(_ bytes: Data) -> (type: String, count: Int)? {
    guard let o = try? JSONValue.parse(bytes), let type = o["type"]?.stringValue else { return nil }
    return (type, o["envelopes"]?.arrayValue?.count ?? 0)
}

extension Edge {
    /// Hands a payload from a one-way link (sound, QR) to `node`; returns new envelopes (JSON).
    public static func acceptPayload(_ node: EdgeGossipNode, _ payload: Data, now: UInt64 = edgeNowSecs()) -> [String] {
        guard gossipType(payload)?.type == "deliver" else { return [] }
        return (try? node.handle(message: payload, nowSecs: now).delivered) ?? []
    }
}

/// One gossip conversation with a peer (spec §11.4) over any two-way link: send our summary
/// with `resync()`, feed whatever the peer sends to `receive(_:)`.
public final class GossipSession {
    private let node: EdgeGossipNode
    private let send: (Data) -> Void
    private let onMessage: (String) -> Void
    private let clock: () -> UInt64

    public init(node: EdgeGossipNode, send: @escaping (Data) -> Void, onMessage: @escaping (String) -> Void,
                clock: @escaping () -> UInt64 = edgeNowSecs) {
        self.node = node
        self.send = send
        self.onMessage = onMessage
        self.clock = clock
    }

    /// Sends our summary (on connect, and after publishing).
    public func resync() {
        send(node.summary(nowSecs: clock()))
    }

    /// Handles one gossip message from the peer. Malformed messages are dropped.
    public func receive(_ bytes: Data) {
        guard let g = gossipType(bytes), let h = try? node.handle(message: bytes, nowSecs: clock()) else { return }
        h.delivered.forEach(onMessage)
        h.replies.forEach(send)
        // We hold something new: advertise it (the peer may also hold more for us).
        if g.type == "deliver" && h.dropped.count < g.count { resync() }
    }
}

/// A gossip session over a BLE connection (spec §11.3): chunks outgoing messages for `write`
/// (a characteristic write or notification) and reassembles incoming chunks. Works as central
/// or peripheral. Set `attMtu` to the negotiated ATT MTU (`maximumWriteValueLength + 3`).
public final class BleLink {
    public static let defaultAttMtu = 23
    public var attMtu: Int
    private var seq: UInt16 = 0
    private let write: (Data) -> Void
    private let reassembler = EdgeChunkReassembler()
    private let clockMs: () -> UInt64
    private var session: GossipSession!

    public init(node: EdgeGossipNode, write: @escaping (Data) -> Void, onMessage: @escaping (String) -> Void,
                attMtu: Int = BleLink.defaultAttMtu, clockMs: @escaping () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1000) }) {
        self.write = write
        self.attMtu = attMtu
        self.clockMs = clockMs
        session = GossipSession(node: node, send: { [unowned self] in self.sendMessage($0) }, onMessage: onMessage,
                                clock: { clockMs() / 1000 })
    }

    private func sendMessage(_ bytes: Data) {
        let s = seq
        seq &+= 1
        guard let chunks = try? Edge.bleChunks(seq: s, bytes, attMtu: UInt32(attMtu)) else { return }
        chunks.forEach(write)
    }

    /// Feeds one notification or write from the peer. Bad chunks are dropped.
    public func receive(_ chunk: Data) {
        let now = clockMs()
        let msg: Data? = (try? reassembler.push(chunk: chunk, nowMs: now)) ?? nil
        _ = reassembler.prune(nowMs: now, timeoutMs: 30_000)
        if let msg { session.receive(msg) }
    }

    /// Sends our summary (on connect, and after publishing).
    public func resync() { session.resync() }
}

/// Data over sound (spec §11.1) at the device's sample rate. `send(_:)` plays a payload through
/// `play`; feed microphone buffers to `onSamples(_:)` and decoded payloads reach `onPayload`.
/// Payloads are short (about 50 bytes/s): use `Edge.deliverPayload` / `Edge.acceptPayload`.
public final class AudioLink {
    public static let modemRate = 48_000
    private let sampleRate: Int
    private let play: ([Float]) -> Void
    private let onPayload: (Data) -> Void
    private let receiver: EdgeAudioReceiver

    public init(sampleRate: Int, play: @escaping ([Float]) -> Void, onPayload: @escaping (Data) -> Void, windowSeconds: Float = 6) {
        self.sampleRate = sampleRate
        self.play = play
        self.onPayload = onPayload
        receiver = EdgeAudioReceiver(sampleRate: UInt32(sampleRate), windowSeconds: windowSeconds)
    }

    /// The samples for `payload` at this link's sample rate, without playing them.
    public func samples(_ payload: Data) throws -> [Float] {
        let s = try Edge.modulate(payload)
        return sampleRate == Self.modemRate ? s : SubEthaCoreFFI.audioResample(samples: s, fromRate: UInt32(Self.modemRate), toRate: UInt32(sampleRate))
    }

    public func send(_ payload: Data) throws { play(try samples(payload)) }

    /// Feeds microphone samples (mono, -1...1, at the link's sample rate).
    public func onSamples(_ samples: [Float]) {
        if let p = receiver.push(samples: samples) { onPayload(p) }
    }
}

/// Animated-QR sender (spec §11.2): an endless stream of fountain-coded frames for a payload, as
/// base45 text for alphanumeric QR codes. Show `text(0)`, `text(1)`, … one after another (5–10 a
/// second); a receiver needs about 1.1–1.5 × `sourceBlocks` of them, in any order.
public final class QrSender {
    /// Fills a version 12 QR code at error correction L (535 alphanumeric characters).
    public static let defaultFrameSize = 356
    private let encoder: EdgeQrEncoder

    public init(payload: Data, frameSize: Int = QrSender.defaultFrameSize) throws {
        encoder = try EdgeQrEncoder(payload: payload, frameSize: UInt32(frameSize))
    }

    /// How many frames carry the payload's blocks directly.
    public var sourceBlocks: Int { Int(encoder.sourceBlocks()) }

    /// Frame `seq` as base45 text.
    public func text(_ seq: Int) -> String { encoder.frameText(seq: UInt32(seq)) }

    /// The frame size that fills a QR code holding `alphanumericChars` characters.
    public static func frameSize(alphanumericChars c: Int) -> Int { c / 3 * 2 + (c % 3 == 2 ? 1 : 0) }
}

/// Collects scanned QR strings into a payload. Other QR codes are ignored, and a new transfer
/// replaces an unfinished one. `onPayload` gets each completed payload once (use
/// `Edge.acceptPayload` for envelopes). Feed it from one queue.
public final class QrReceiver {
    private let decoder = EdgeQrDecoder()
    private let onPayload: (Data) -> Void
    private var last: Data?

    public init(onPayload: @escaping (Data) -> Void) { self.onPayload = onPayload }

    /// Feeds one scanned string; returns progress, or nil if it wasn't a SubEtha frame.
    @discardableResult
    public func push(_ text: String) -> EdgeQrProgress? {
        let p = decoder.pushText(text: text)
        guard p.accepted else { return nil }
        if p.complete, let result = decoder.result(), result != last {
            last = result
            onPayload(result)
        }
        return p
    }
}

/// Edge ↔ relay bridge (PLAN §3: a phone with internet is a gateway for nearby offline devices).
/// Relay messages on `topics` enter `node` (given `hops` if they carry none) so edge peers pick
/// them up; call `uplink(_:)` from your links' onMessage to publish edge messages to the relay
/// unchanged. `onDownlink` runs on the bridge's task: hop to your links' queue there.
public final class EdgeBridge: @unchecked Sendable {
    private let client: SubEtha
    private let node: EdgeGossipNode
    private let topics: Set<String>
    private let uplinkEnabled: Bool
    private let onError: (@Sendable (Error) -> Void)?
    private let lock = NSLock()
    private var uplinked: [String] = []
    private var uplinkedSet: Set<String> = []
    private var task: Task<Void, Never>?

    public init(client: SubEtha, node: EdgeGossipNode, topics: [String], hops: Int = 1, downlink: Bool = true,
                uplink: Bool = true, since: String? = nil,
                onDownlink: (@Sendable (String) -> Void)? = nil, onError: (@Sendable (Error) -> Void)? = nil) {
        self.client = client
        self.node = node
        self.topics = Set(topics)
        self.uplinkEnabled = uplink
        self.onError = onError
        // Subscribed, not just relayable, so edge messages on these topics reach onMessage.
        for t in self.topics { node.subscribe(topic: t) }
        guard downlink else { return }
        var options = SubscribeOptions(since: since, onError: onError)
        options.raw = true
        let node = self.node
        task = Task {
            do {
                try await client.subscribe(topics, options: options) { m in
                    var env = m.json
                    env["event"] = nil
                    if (env["hops"]?.intValue ?? 0) <= 0 { env["hops"] = .int(Int64(hops)) }
                    let text = JSONValue.object(env).jsonString()
                    if env["id"] != nil, (try? node.publish(envelopeJson: text, nowSecs: edgeNowSecs())) == true { onDownlink?(text) }
                }
            } catch is CancellationError {
            } catch {
                onError?(error)
            }
        }
    }

    /// Publishes a message that arrived over an edge link. Returns true if it was published.
    @discardableResult
    public func uplink(_ envelopeJSON: String) async -> Bool {
        guard uplinkEnabled, let env = (try? JSONValue.parse(envelopeJSON))?.objectValue,
              let topic = env["topic"]?.stringValue, topics.contains(topic),
              let id = env["id"]?.stringValue?.uppercased() else { return false }
        lock.lock()
        let fresh = uplinkedSet.insert(id).inserted
        if fresh {
            uplinked.append(id)
            if uplinked.count > 10_000 { uplinkedSet.remove(uplinked.removeFirst()) }
        }
        lock.unlock()
        guard fresh else { return false }
        do {
            try await client.publishEnvelope(env)
            return true
        } catch {
            lock.lock()
            uplinkedSet.remove(id)
            lock.unlock()
            onError?(error)
            return false
        }
    }

    public func close() { task?.cancel() }
}
