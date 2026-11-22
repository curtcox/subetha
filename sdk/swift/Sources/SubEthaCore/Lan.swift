import Foundation
import SubEthaCoreFFI

// LAN discovery and gossip (spec §11.5), mirroring sdk/js/src/edge/lan.ts and the Kotlin SDK's
// Lan.kt. Peers multicast a beacon (node id + unicast port) every few seconds and gossip over
// unicast UDP, each gossip message split into datagrams with the BLE chunk framing.

/// LAN gossip without sockets: known peers, per-peer reassembly, and the gossip exchange. Feed
/// it multicast datagrams (`onBeacon`) and unicast ones (`onDatagram`); it sends through `send`.
/// The app owns the sockets (on iOS, multicast needs Apple's
/// `com.apple.developer.networking.multicast` entitlement). Thread-safe.
public final class LanGossip: @unchecked Sendable {
    public static let peerTimeoutMs: UInt64 = 30_000
    private static let reassemblyTimeoutMs: UInt64 = 10_000

    private final class Peer {
        let host: String
        let port: UInt16
        var seen: UInt64
        let reassembler = EdgeChunkReassembler()
        init(host: String, port: UInt16, seen: UInt64) {
            self.host = host
            self.port = port
            self.seen = seen
        }
    }

    public let nodeId: String
    /// Our unicast port, announced in beacons.
    public let port: UInt16
    private let node: EdgeGossipNode
    private let send: (_ host: String, _ port: UInt16, _ datagram: Data) -> Void
    private let onMessage: (String) -> Void
    private let clockMs: () -> UInt64
    private let lock = NSLock()
    private var peers: [String: Peer] = [:]
    private var seq: UInt16 = 0

    public init(node: EdgeGossipNode, port: UInt16, send: @escaping (_ host: String, _ port: UInt16, _ datagram: Data) -> Void,
                onMessage: @escaping (String) -> Void, nodeId: String = Edge.newLanNodeId(),
                clockMs: @escaping () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1000) }) {
        self.node = node
        self.port = port
        self.send = send
        self.onMessage = onMessage
        self.nodeId = nodeId
        self.clockMs = clockMs
    }

    /// The beacon to multicast every few seconds.
    public func beacon() -> Data { Edge.lanBeacon(node: nodeId, port: port) }

    public var peerCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return peers.count
    }

    private func sendTo(_ p: Peer, _ message: Data) {
        lock.lock()
        let s = seq
        seq &+= 1
        lock.unlock()
        guard let datagrams = try? Edge.lanDatagrams(seq: s, message) else { return }
        for d in datagrams { send(p.host, p.port, d) }
    }

    private func expire() {
        let t = clockMs()
        lock.lock()
        peers = peers.filter { t < $0.value.seen || t - $0.value.seen <= Self.peerTimeoutMs }
        lock.unlock()
    }

    private func summary() -> Data { node.summary(nowSecs: clockMs() / 1000) }

    /// Handles a multicast datagram. A newly seen peer gets our summary.
    public func onBeacon(_ bytes: Data, fromHost: String) {
        guard let b = SubEthaCoreFFI.lanParseBeacon(bytes: bytes), b.node != nodeId else { return }
        expire()
        let key = "\(fromHost):\(b.port)"
        lock.lock()
        if let known = peers[key] {
            known.seen = clockMs()
            lock.unlock()
            return
        }
        let fresh = Peer(host: fromHost, port: b.port, seen: clockMs())
        peers[key] = fresh
        lock.unlock()
        sendTo(fresh, summary())
    }

    /// Handles a unicast datagram. Unknown senders are answered too (beacons can be lost).
    public func onDatagram(_ bytes: Data, fromHost: String, fromPort: UInt16) {
        let key = "\(fromHost):\(fromPort)"
        lock.lock()
        let known = peers[key]
        let p = known ?? Peer(host: fromHost, port: fromPort, seen: clockMs())
        if known == nil { peers[key] = p }
        let now = clockMs()
        let message: Data? = (try? p.reassembler.push(chunk: bytes, nowMs: now)) ?? nil
        _ = p.reassembler.prune(nowMs: now, timeoutMs: Self.reassemblyTimeoutMs)
        lock.unlock()
        guard let message, let g = gossipType(message), let h = try? node.handle(message: message, nowSecs: now / 1000) else { return }
        h.delivered.forEach(onMessage)
        h.replies.forEach { sendTo(p, $0) }
        // A peer we hadn't heard a beacon from yet: offer what we hold right away.
        if known == nil { sendTo(p, summary()) }
        // Something new arrived: tell every peer (they may want it), including this one.
        if g.type == "deliver" && h.dropped.count < g.count { resync() }
    }

    /// Sends our summary to every known peer (after publishing).
    public func resync() {
        expire()
        let s = summary()
        lock.lock()
        let all = Array(peers.values)
        lock.unlock()
        all.forEach { sendTo($0, s) }
    }
}
