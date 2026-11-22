import Foundation
import XCTest
import SubEtha
import SubEthaCore

/// LanGossip in memory (the app owns the sockets).
final class LanTests: XCTestCase {
    let topic = "@alice/lan"
    func now() -> UInt64 { UInt64(Date().timeIntervalSince1970) }
    func env(_ msg: String, hops: Int = 2) -> String {
        "{\"id\":\"\(Core.newMessageId())\",\"time\":\(now()),\"expires\":\(now() + 600),\"topic\":\"\(topic)\",\"message\":\"\(msg)\",\"hops\":\(hops)}"
    }
    func message(_ json: String) -> String? { (try? JSONValue.parse(json))?["message"]?.stringValue }
    func node() -> EdgeGossipNode {
        let n = EdgeGossipNode(requireSignatures: false)
        n.subscribe(topic: topic)
        return n
    }

    func testPeersFindEachOtherByBeaconAndSpreadLargeMessages() throws {
        let hosts = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
        var inbox: [[String]] = [[], [], []]
        var sizes: [Int] = []
        var lans: [LanGossip] = []
        for (i, host) in hosts.enumerated() {
            let n = node()
            XCTAssertTrue(try n.publish(envelopeJson: env("from \(host) " + String(repeating: "x", count: i == 0 ? 3000 : 10)), nowSecs: now()))
            lans.append(LanGossip(node: n, port: UInt16(9000 + i), send: { h, p, d in
                sizes.append(d.count)
                let j = hosts.firstIndex(of: h)!
                XCTAssertEqual(Int(p), 9000 + j)
                lans[j].onDatagram(d, fromHost: host, fromPort: UInt16(9000 + i))
            }, onMessage: { inbox[i].append($0) }))
        }
        for i in 0..<3 { for j in 0..<3 where i != j { lans[j].onBeacon(lans[i].beacon(), fromHost: hosts[i]) } }
        for (i, got) in inbox.enumerated() {
            XCTAssertEqual(got.count, 2, hosts[i])
            XCTAssertFalse(got.compactMap(message).contains { $0.hasPrefix("from \(hosts[i])") })
        }
        XCTAssertLessThanOrEqual(sizes.max()!, 1200 + 6)
        XCTAssertGreaterThanOrEqual(sizes.filter { $0 > 1000 }.count, 2)
        XCTAssertEqual(lans[0].peerCount, 2)
        lans[0].onBeacon(lans[0].beacon(), fromHost: hosts[0]) // our own beacon is ignored
        lans[0].onBeacon(Data("junk".utf8), fromHost: hosts[1])
        XCTAssertEqual(lans[0].peerCount, 2)
    }

    func testPeersExpireAndUnknownSendersAreAnswered() throws {
        var clock: UInt64 = 1_000_000
        var sent: [String] = []
        let a = LanGossip(node: node(), port: 9100, send: { h, p, _ in sent.append("\(h):\(p)") }, onMessage: { _ in },
                          clockMs: { clock })
        let b = LanGossip(node: node(), port: 9101, send: { _, _, _ in }, onMessage: { _ in })
        a.onBeacon(b.beacon(), fromHost: "10.0.0.9")
        XCTAssertEqual(a.peerCount, 1)
        clock += LanGossip.peerTimeoutMs + 1
        a.resync()
        XCTAssertEqual(a.peerCount, 0)
        sent.removeAll()
        let d = try Edge.lanDatagrams(seq: 7, Data("{\"type\":\"summary\",\"topics\":{}}".utf8))
        a.onDatagram(d[0], fromHost: "10.0.0.7", fromPort: 5555)
        XCTAssertTrue(sent.contains("10.0.0.7:5555"))
    }
}
