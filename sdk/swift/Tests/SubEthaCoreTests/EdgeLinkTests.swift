import Foundation
import XCTest
import SubEtha
import SubEthaCore

/// The edge link drivers in EdgeLinks.swift, wired back to back in memory.
final class EdgeLinkTests: XCTestCase {
    let topic = "@alice/doorbell"
    func now() -> UInt64 { UInt64(Date().timeIntervalSince1970) }
    func env(_ msg: String, hops: Int = 2) -> String {
        "{\"id\":\"\(Core.newMessageId())\",\"time\":\(now()),\"topic\":\"\(topic)\",\"message\":\"\(msg)\",\"hops\":\(hops)}"
    }
    func message(_ json: String) -> String? { (try? JSONValue.parse(json))?["message"]?.stringValue }

    func testBleLinksGossipBothWays() throws {
        let phone = EdgeGossipNode(requireSignatures: false)
        let watch = EdgeGossipNode(requireSignatures: false)
        phone.subscribe(topic: topic)
        watch.subscribe(topic: topic)
        var atPhone: [String] = []
        var atWatch: [String] = []
        var phoneLink: BleLink!
        var watchLink: BleLink!
        phoneLink = BleLink(node: phone, write: { watchLink.receive($0) }, onMessage: { atPhone.append($0) }, attMtu: 23)
        watchLink = BleLink(node: watch, write: { phoneLink.receive($0) }, onMessage: { atWatch.append($0) }, attMtu: 185)
        XCTAssertTrue(try phone.publish(envelopeJson: env("ding"), nowSecs: now()))
        XCTAssertTrue(try watch.publish(envelopeJson: env("dong"), nowSecs: now()))
        phoneLink.resync()
        XCTAssertEqual(atWatch.compactMap(message), ["ding"])
        XCTAssertEqual(atPhone.compactMap(message), ["dong"])
        watchLink.receive(Data([1, 2, 3])) // dropped, not thrown
        phoneLink.resync()
        XCTAssertEqual(atWatch.count, 1)
    }

    func testQrSenderToReceiver() throws {
        let node = EdgeGossipNode(requireSignatures: false)
        node.subscribe(topic: topic)
        var got: [String] = []
        let receiver = QrReceiver { got += Edge.acceptPayload(node, $0) }
        let envs = (1...6).map { env("message \($0) with some padding to need several frames") }
        let sender = try QrSender(payload: try Edge.deliverPayload(envs), frameSize: 120)
        XCTAssertGreaterThan(sender.sourceBlocks, 1)
        XCTAssertNil(receiver.push("https://example.com/not-ours"))
        // Start late and skip every third frame, as a camera would.
        var seq = 3
        while got.isEmpty && seq < 200 {
            if seq % 3 != 0 { receiver.push(sender.text(seq)) }
            seq += 1
        }
        XCTAssertEqual(got.compactMap(message), envs.compactMap(message))
        receiver.push(sender.text(seq)) // same transfer: not delivered again
        XCTAssertEqual(got.count, 6)
        receiver.push(try QrSender(payload: try Edge.deliverPayload([env("next")])).text(0))
        XCTAssertEqual(got.last.flatMap(message), "next")
        XCTAssertEqual(QrSender.frameSize(alphanumericChars: 535), 356)
    }

    func testAudioLinkRoundTripAt44k() throws {
        let node = EdgeGossipNode(requireSignatures: false)
        node.subscribe(topic: topic)
        let payload = try Edge.deliverPayload([env("hi", hops: 1)])
        var got: [Data] = []
        let link = AudioLink(sampleRate: 44_100, play: { _ in }, onPayload: { got.append($0) }, windowSeconds: Float(payload.count) / 40 + 2)
        let noise = (0..<22_050).map { Float(0.01 * sin(2 * Double.pi * 440 * Double($0) / 44_100)) }
        let all = noise + (try link.samples(payload)) + noise + [Float](repeating: 0, count: 44_100)
        var i = 0
        while i < all.count {
            link.onSamples(Array(all[i..<min(i + 2048, all.count)]))
            i += 2048
        }
        XCTAssertEqual(got.count, 1)
        XCTAssertEqual(Edge.acceptPayload(node, got[0]).compactMap(message), ["hi"])
        XCTAssertEqual(Edge.acceptPayload(node, got[0]), [], "duplicates are dropped")
        XCTAssertEqual(Edge.acceptPayload(node, node.summary(nowSecs: now())), [], "only deliver messages are accepted")
    }
}
