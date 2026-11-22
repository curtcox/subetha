import Foundation
import XCTest
import SubEtha
import SubEthaCore

/// Edge transports through the core, against spec/vectors/edge.json.
final class EdgeTests: XCTestCase {
    func edgeVectors() throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../../spec/vectors/edge.json").standardizedFileURL
        return try JSONValue.parse(Data(contentsOf: url))
    }

    func testBleAndLanFramesMatchTheVectors() throws {
        let v = try edgeVectors()
        let ble = v["ble"]!
        let chunks = try Edge.bleChunks(seq: UInt16(ble["seq"]!.intValue!), Data(ble["payload"]!.stringValue!.utf8), attMtu: UInt32(ble["att_mtu"]!.intValue!))
        XCTAssertEqual(chunks.map { Encoding.hex($0) }, ble["chunks"]!.arrayValue!.map { $0.stringValue! })

        let lan = v["lan"]!
        let n = Int(lan["payload_len"]!.intValue!)
        let payload = Data((0..<n).map { UInt8(($0 * 31 + 7) % 256) })
        let datagrams = try Edge.lanDatagrams(seq: UInt16(lan["seq"]!.intValue!), payload)
        XCTAssertEqual(datagrams.map { Encoding.hex($0) }, lan["datagrams"]!.arrayValue!.map { $0.stringValue! })
    }

    func testFountainFramesAndDecoder() throws {
        let f = try edgeVectors()["fountain"]!
        let text = f["payload"]!.stringValue!
        let enc = try EdgeQrEncoder(payload: Data(text.utf8), frameSize: UInt32(f["frame_size"]!.intValue!))
        let dec = EdgeQrDecoder()
        for fr in f["frames"]!.arrayValue!.reversed() {
            let hex = fr["hex"]!.stringValue!
            XCTAssertEqual(Encoding.hex(enc.frame(seq: UInt32(fr["seq"]!.intValue!))), hex)
            _ = dec.pushFrame(frame: Encoding.hexDecode(hex)!)
        }
        XCTAssertEqual(dec.result().map { String(decoding: $0, as: UTF8.self) }, text)
        XCTAssertFalse(dec.pushText(text: "https://example.com").accepted)
    }

    func testAudioRoundTrip() throws {
        let pcm = try Edge.modulate(Data("wake".utf8))
        XCTAssertEqual(Edge.demodulate(pcm), Data("wake".utf8))
        let rx = EdgeAudioReceiver(sampleRate: 48000, windowSeconds: 3)
        var got: [Data] = []
        var i = 0
        let padded = pcm + [Float](repeating: 0, count: 48000)
        while i < padded.count {
            if let p = rx.push(samples: Array(padded[i..<min(i + 4096, padded.count)])) { got.append(p) }
            i += 4096
        }
        XCTAssertEqual(got, [Data("wake".utf8)])
    }

    func testGossipOverBleChunks() throws {
        let topic = "@alice/doorbell"
        let now: UInt64 = 1_763_750_000
        let phone = EdgeGossipNode(requireSignatures: false)
        let watch = EdgeGossipNode(requireSignatures: false)
        phone.subscribe(topic: topic)
        watch.subscribe(topic: topic)
        let env = "{\"id\":\"\(Core.newMessageId())\",\"time\":\(now),\"topic\":\"\(topic)\",\"message\":\"ding\",\"hops\":1}"
        XCTAssertTrue(try phone.publish(envelopeJson: env, nowSecs: now))
        let toWatch = EdgeChunkReassembler()
        let toPhone = EdgeChunkReassembler()
        var queue: [(Bool, Data)] = [(true, phone.summary(nowSecs: now))]
        var delivered: [String] = []
        var seq: UInt16 = 0
        while !queue.isEmpty {
            let (forWatch, msg) = queue.removeFirst()
            let node = forWatch ? watch : phone
            let reasm = forWatch ? toWatch : toPhone
            var whole: Data?
            for c in try Edge.bleChunks(seq: seq, msg, attMtu: 23) {
                if let m = try reasm.push(chunk: c, nowMs: 0) { whole = m }
            }
            seq += 1
            let h = try node.handle(message: whole!, nowSecs: now)
            delivered += h.delivered
            queue += h.replies.map { (!forWatch, $0) }
        }
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(try JSONValue.parse(Data(delivered[0].utf8))["message"]?.stringValue, "ding")
        let again = try watch.handle(message: Edge.deliverPayload([env]), nowSecs: now)
        XCTAssertTrue(again.dropped.first?.hasSuffix(":duplicate") ?? false)
    }
}
