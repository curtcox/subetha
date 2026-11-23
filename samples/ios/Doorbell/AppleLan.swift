import Darwin
import Foundation
import SubEthaCore

/// The platform half of LAN gossip (spec §11.5): BSD UDP sockets driving SubEthaCore's
/// `LanGossip`. A multicast socket on `Edge.lanGroup`:`Edge.lanPort` sends and hears beacons; a
/// unicast socket carries gossip, so datagrams leave from the port the beacons announce.
///
/// On iOS 14+ the first use asks for local network access (NSLocalNetworkUsageDescription), and
/// joining the multicast group needs Apple's `com.apple.developer.networking.multicast`
/// entitlement (granted on request); without it `start()` throws and the tab says so. Peers on
/// the same Wi-Fi include the Android sample and `subetha lan` on a laptop.
final class AppleLan: @unchecked Sendable {
    struct SocketError: LocalizedError {
        let call: String
        let code: Int32
        var errorDescription: String? { "\(call): \(String(cString: strerror(code)))" }
    }

    private let queue = DispatchQueue(label: "us.subetha.sample.lan")
    private let node: EdgeGossipNode
    private let onMessage: (String) -> Void
    private var unicast: Int32 = -1
    private var multicast: Int32 = -1
    private var gossip: LanGossip?
    private var sources: [DispatchSourceRead] = []
    private var timer: DispatchSourceTimer?

    var nodeId: String { gossip?.nodeId ?? "" }
    var peerCount: Int { gossip?.peerCount ?? 0 }

    init(node: EdgeGossipNode, onMessage: @escaping (String) -> Void) {
        self.node = node
        self.onMessage = onMessage
    }

    /// Opens the sockets, joins the group, and starts beaconing every `beaconSeconds`.
    func start(beaconSeconds: Double = 5) throws {
        do {
            unicast = try Self.udpSocket(port: 0, reuse: false)
            multicast = try Self.udpSocket(port: Edge.lanPort, reuse: true)
            var mreq = ip_mreq(imr_multiaddr: in_addr(s_addr: inet_addr(Edge.lanGroup)), imr_interface: in_addr(s_addr: 0))
            guard setsockopt(multicast, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, socklen_t(MemoryLayout<ip_mreq>.size)) == 0 else {
                throw SocketError(call: "IP_ADD_MEMBERSHIP", code: errno)
            }
            var ttl: UInt8 = 1
            var loop: UInt8 = 1
            _ = setsockopt(multicast, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, 1)
            _ = setsockopt(multicast, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, 1)
        } catch {
            stop()
            throw error
        }
        let unicast = unicast
        let g = LanGossip(node: node, port: Self.localPort(unicast),
                          send: { host, port, datagram in Self.send(datagram, to: host, port: port, from: unicast) },
                          onMessage: onMessage)
        gossip = g
        sources = [read(unicast) { data, host, port in g.onDatagram(data, fromHost: host, fromPort: port) },
                   read(multicast) { data, host, _ in g.onBeacon(data, fromHost: host) }]
        let multicast = multicast
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: beaconSeconds)
        t.setEventHandler { Self.send(g.beacon(), to: Edge.lanGroup, port: Edge.lanPort, from: multicast) }
        t.resume()
        timer = t
    }

    /// Sends our summary to every peer (after publishing, or when another link brought news).
    func resync() {
        guard let g = gossip else { return }
        queue.async { g.resync() }
    }

    func stop() {
        timer?.cancel()
        timer = nil
        sources.forEach { $0.cancel() } // their cancel handlers close the sockets
        if sources.isEmpty {
            if unicast >= 0 { Darwin.close(unicast) }
            if multicast >= 0 { Darwin.close(multicast) }
        }
        sources = []
        unicast = -1
        multicast = -1
        gossip = nil
    }

    deinit { stop() }

    // ---- sockets ----

    private static func udpSocket(port: UInt16, reuse: Bool) throws -> Int32 {
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { throw SocketError(call: "socket", code: errno) }
        var on: Int32 = 1
        if reuse {
            _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
            _ = setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &on, socklen_t(MemoryLayout<Int32>.size))
        }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: 0)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else {
            let code = errno
            Darwin.close(fd)
            throw SocketError(call: "bind", code: code)
        }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        return fd
    }

    private static func localPort(_ fd: Int32) -> UInt16 {
        var addr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        return UInt16(bigEndian: addr.sin_port)
    }

    private static func send(_ data: Data, to host: String, port: UInt16, from fd: Int32) {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr(host))
        data.withUnsafeBytes { raw in
            _ = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    sendto(fd, raw.baseAddress, raw.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
    }

    /// Drains `fd` on the queue whenever it's readable, handing each datagram and its sender
    /// to `handle`. Cancelling the source closes the socket.
    private func read(_ fd: Int32, _ handle: @escaping (Data, String, UInt16) -> Void) -> DispatchSourceRead {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler {
            var buf = [UInt8](repeating: 0, count: 65_535)
            while true {
                var from = sockaddr_in()
                var len = socklen_t(MemoryLayout<sockaddr_in>.size)
                let n = buf.withUnsafeMutableBytes { b in
                    withUnsafeMutablePointer(to: &from) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, b.baseAddress, b.count, 0, $0, &len) }
                    }
                }
                if n <= 0 { return } // EAGAIN: drained
                handle(Data(buf[0..<n]), String(cString: inet_ntoa(from.sin_addr)), UInt16(bigEndian: from.sin_port))
            }
        }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
        return source
    }
}
