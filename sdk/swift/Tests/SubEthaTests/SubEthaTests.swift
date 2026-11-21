import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#endif
@testable import SubEtha

/// Records requests and answers from a handler. `lines` responses stream line by line and,
/// with `hold`, stay open until the consumer cancels.
final class MockTransport: HTTPTransport, @unchecked Sendable {
    struct Reply {
        var status = 200
        var body = ""
        var lines: [String]? = nil
        var hold = false
        var headers: [String: String] = [:]
    }

    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private let handler: @Sendable (URLRequest, Int) -> Reply

    init(_ handler: @escaping @Sendable (URLRequest, Int) -> Reply) { self.handler = handler }

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return _requests }

    private func record(_ r: URLRequest) -> Int {
        lock.lock(); defer { lock.unlock() }
        _requests.append(r)
        return _requests.count
    }

    private func response(_ r: URLRequest, _ reply: Reply) -> HTTPURLResponse {
        HTTPURLResponse(url: r.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let reply = handler(request, record(request))
        let body = reply.lines.map { $0.joined(separator: "\n") + "\n" } ?? reply.body
        return (Data(body.utf8), response(request, reply))
    }

    func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let reply = handler(request, record(request))
        let lines = reply.lines ?? reply.body.split(separator: "\n").map(String.init)
        let stream = AsyncThrowingStream<String, Error> { c in
            let task = Task {
                for l in lines { c.yield(l) }
                if reply.hold {
                    while !Task.isCancelled { try? await Task.sleep(nanoseconds: 10_000_000) }
                }
                c.finish()
            }
            c.onTermination = { _ in task.cancel() }
        }
        return (stream, response(request, reply))
    }
}

func bodyJSON(_ r: URLRequest) -> [String: JSONValue] {
    (try? JSONValue.parse(r.httpBody ?? Data()).objectValue) ?? [:]
}

func pathAndQuery(_ r: URLRequest) -> String {
    let c = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)!
    return c.percentEncodedPath + (c.percentEncodedQuery.map { "?\($0)" } ?? "")
}

let base = URL(string: "https://x.test/")!
let seedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
let deviceID = "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena"

final class SubEthaTests: XCTestCase {
    func testPublishSendsJSONWithAuthIdempotencyAndRoute() async throws {
        let t = MockTransport { r, _ in .init(body: String(decoding: r.httpBody!, as: UTF8.self)) }
        let c = SubEtha(baseURL: base, token: "se_t", transport: t)
        let m = try await c.publish("@a/b", "hi", PublishOptions(title: "T", priority: 3, tags: ["x"],
            route: Route(mode: .fast, maxCostUSD: 0.02, deny: ["sms"]), idempotencyKey: "k"))
        let r = t.requests[0]
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.url?.absoluteString, "https://x.test/")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer se_t")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Idempotency-Key"), "k")
        XCTAssertEqual(bodyJSON(r), ["topic": "@a/b", "message": "hi", "title": "T", "tags": ["x"],
                                     "route": ["mode": "fast", "max_cost_usd_micros": 20000, "deny": ["sms"]]])
        XCTAssertEqual(m.message, "hi")
        XCTAssertEqual(m.priority, 3)
    }

    func testEstimateSendsDryRun() async throws {
        let t = MockTransport { r, _ in
            .init(body: #"{"dry_run":true,"estimate_usd_micros":1500,"plan":[{"transport":"ws"},{"transport":"sms"}],"message":"# + String(decoding: r.httpBody!, as: UTF8.self) + "}")
        }
        let e = try await SubEtha(baseURL: base, transport: t).estimate("@a/b", "ding", PublishOptions(route: Route(mode: .all)))
        XCTAssertEqual(t.requests[0].value(forHTTPHeaderField: "X-Dry-Run"), "1")
        XCTAssertEqual(e.estimateUSDMicros, 1500)
        XCTAssertEqual(e.plan.compactMap { $0["transport"]?.stringValue }, ["ws", "sms"])
        XCTAssertEqual(e.message?.message, "ding")
    }

    func testErrorsCarryCodeStatusAndBody() async throws {
        let t = MockTransport { _, _ in
            .init(status: 402, body: #"{"error":"insufficient_balance","http":402,"message":"no money","shortfall_usd_micros":5}"#, headers: ["Retry-After": "7"])
        }
        do {
            try await SubEtha(baseURL: base, transport: t).publish("@a/b", "x")
            XCTFail("expected an error")
        } catch let e as SubEthaError {
            XCTAssertEqual(e.code, "insufficient_balance")
            XCTAssertEqual(e.status, 402)
            XCTAssertEqual(e.body["shortfall_usd_micros"], 5)
            XCTAssertEqual(e.retryAfter, 7)
            XCTAssertFalse(e.retryable)
        }
        let t2 = MockTransport { _, _ in .init(status: 503, body: "upstream down") }
        do {
            _ = try await SubEtha(baseURL: base, transport: t2).balance()
            XCTFail("expected an error")
        } catch let e as SubEthaError {
            XCTAssertEqual(e.code, "provider_unavailable")
            XCTAssertEqual(e.message, "upstream down")
            XCTAssertTrue(e.retryable)
        }
    }

    func testPollParsesNDJSONAndEncodesTopics() async throws {
        let t = MockTransport { _, _ in .init(lines: [#"{"id":"01A","topic":"@a/b c","message":"one"}"#, #"{"id":"01B","topic":"@a/b c","message":"two"}"#]) }
        let got = try await SubEtha(baseURL: base, transport: t).poll(["@a/b c", "@a/d"], priority: [4, 5])
        XCTAssertEqual(got.map(\.message), ["one", "two"])
        XCTAssertEqual(pathAndQuery(t.requests[0]), "/@a/b%20c,@a/d/json?poll=1&since=all&priority=4,5")
    }

    func testSubscribeDedupesResumesFromLastIdAndAcks() async throws {
        let t = MockTransport { r, n in
            if r.url!.path == "/v1/ack" { return .init(body: #"{"acked":true}"#) }
            if !pathAndQuery(r).contains("since=") {
                return .init(lines: [#"{"event":"open"}"#,
                                     #"{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one","event":"message"}"#,
                                     #"{"id":"01jd0000000000000000000001","topic":"@a/b","message":"one"}"#,
                                     #"{"event":"keepalive"}"#])
            }
            return .init(lines: [#"{"event":"open"}"#,
                                 #"{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one"}"#,
                                 #"{"id":"01JD0000000000000000000002","topic":"@a/b","message":"two"}"#], hold: true)
        }
        let c = SubEtha(baseURL: base, token: "se_t", transport: t)
        var got: [String] = []
        for try await m in c.messages(["@a/b"], options: SubscribeOptions(initialBackoff: 0.01)) {
            got.append(m.message ?? "")
            if got.count == 2 { break }
        }
        XCTAssertEqual(got, ["one", "two"])
        let subs = t.requests.filter { $0.url!.path.hasSuffix("/json") }.map(pathAndQuery)
        XCTAssertEqual(subs[0], "/@a/b/json")
        XCTAssertEqual(subs[1], "/@a/b/json?since=01JD0000000000000000000001")
        let acks = t.requests.filter { $0.url!.path == "/v1/ack" }.map(bodyJSON)
        XCTAssertEqual(acks.first?["id"], "01JD0000000000000000000001")
        XCTAssertEqual(acks.first?["via"], "stream")
    }

    func testSubscribeThrowsOnAuthErrors() async throws {
        let t = MockTransport { _, _ in .init(status: 403, body: #"{"error":"forbidden","message":"no scope"}"#) }
        do {
            try await SubEtha(baseURL: base, transport: t).subscribe(["@a/b"]) { _ in }
            XCTFail("expected an error")
        } catch let e as SubEthaError {
            XCTAssertEqual(e.code, "forbidden")
            XCTAssertEqual(t.requests.count, 1)
        }
    }

    func testSubscribeRetriesServerErrors() async throws {
        let t = MockTransport { _, n in
            n < 3 ? .init(status: 500, body: #"{"error":"internal"}"#) : .init(lines: [#"{"id":"01X","topic":"@a/b","message":"ok"}"#], hold: true)
        }
        var first: Message?
        for try await m in SubEtha(baseURL: base, transport: t).messages(["@a/b"], options: SubscribeOptions(autoAck: false, initialBackoff: 0.001)) {
            first = m
            break
        }
        XCTAssertEqual(first?.message, "ok")
        XCTAssertEqual(t.requests.count, 3)
    }

    func testPollTransportDeliversNewMessagesOnly() async throws {
        let t = MockTransport { _, n in
            n == 1 ? .init(lines: [#"{"id":"01P1","topic":"@a/b","message":"p1"}"#])
                   : .init(lines: [#"{"id":"01P1","topic":"@a/b","message":"p1"}"#, #"{"id":"01P2","topic":"@a/b","message":"p2"}"#])
        }
        var got: [String] = []
        for try await m in SubEtha(baseURL: base, transport: t).messages(["@a/b"], options: SubscribeOptions(transport: .poll, pollInterval: 0.01, autoAck: false)) {
            got.append(m.message ?? "")
            if got.count == 2 { break }
        }
        XCTAssertEqual(got, ["p1", "p2"])
        XCTAssertTrue(pathAndQuery(t.requests[0]).contains("since=all"))
        XCTAssertTrue(pathAndQuery(t.requests[1]).contains("since=01P1"))
    }

    func testRequestSigningInput() {
        let nonce = "nonce_0123456789abcdef"
        XCTAssertEqual(RequestSigning.input(method: "post", url: URL(string: "https://x.test/v1/ack?x=1")!, time: 1763750000, nonce: nonce, body: Data("{}".utf8)),
                       "subetha-req-v1\nPOST\nx.test\n/v1/ack?x=1\n1763750000\n\(nonce)\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
        // Host as WHATWG URL.host: lowercase, default port dropped, other ports kept.
        XCTAssertEqual(RequestSigning.input(method: "GET", url: URL(string: "https://X.test:443")!, time: 5, nonce: nonce, body: Data()),
                       "subetha-req-v1\nGET\nx.test\n/\n5\n\(nonce)\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertTrue(RequestSigning.input(method: "GET", url: URL(string: "http://127.0.0.1:8080/a%20b?q=1")!, time: 5, nonce: nonce, body: Data())
            .hasPrefix("subetha-req-v1\nGET\n127.0.0.1:8080\n/a%20b?q=1\n"))
        let a = RequestSigning.newNonce()
        XCTAssertEqual(a.count, 22)
        XCTAssertNotEqual(a, RequestSigning.newNonce())
    }

    func testEncodingAndULID() {
        XCTAssertEqual(Encoding.base32(Data()), "")
        XCTAssertEqual(Encoding.base32(Data([0x66])), "my")
        XCTAssertEqual(Encoding.base32(Data("foobar".utf8)), "mzxw6ytboi")
        XCTAssertEqual(Encoding.base64urlDecode(Encoding.base64url(Data([0xfb, 0xff]))), Data([0xfb, 0xff]))
        XCTAssertEqual(ULID.make().count, 26)
        XCTAssertEqual(SubEtha.topicPath(["@a/b", "@a/c"]), "@a/b,@a/c")
    }

    #if canImport(CryptoKit)
    func testCryptoKitSignerAndDeviceSignedRequests() async throws {
        let signer = try CryptoKitDeviceSigner(seed: Encoding.hexDecode(seedHex)!)
        XCTAssertEqual(signer.deviceId, deviceID)
        let t = MockTransport { _, _ in .init(body: "{}") }
        let c = SubEtha(baseURL: base, token: "se_t", deviceSigner: signer, signRequests: true, transport: t, clock: { 1763750000 })
        try await c.ack(topic: "@a/b", id: "01Z")
        let r = t.requests[0]
        XCTAssertNil(r.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-Device-Id"), deviceID)
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-Device-Time"), "1763750000")
        let nonce = try XCTUnwrap(r.value(forHTTPHeaderField: "X-Device-Nonce"))
        XCTAssertEqual(nonce.count, 22)
        let input = RequestSigning.input(method: "POST", url: r.url!, time: 1763750000, nonce: nonce, body: r.httpBody!)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: signer.publicKey)
        let sig = Encoding.base64urlDecode(r.value(forHTTPHeaderField: "X-Device-Signature")!)!
        XCTAssertTrue(pub.isValidSignature(sig, for: Data(input.utf8)))
        XCTAssertThrowsError(try signer.signEnvelope("{}"))
    }

    func testEnrollmentFlow() async throws {
        let t = MockTransport { r, n in
            if r.url!.path == "/v1/device/code" {
                return .init(body: #"{"device_code":"dc","user_code":"BCDF-GHJK","verification_uri":"https://x/console/#device","verification_uri_complete":"https://x/console/#device=BCDF-GHJK","expires_in":600,"interval":0}"#)
            }
            return n == 2 ? .init(status: 400, body: #"{"error":"authorization_pending"}"#) : .init(body: #"{"account_id":"acct_1"}"#)
        }
        let signer = try CryptoKitDeviceSigner(seed: Encoding.hexDecode(seedHex)!)
        let c = SubEtha(baseURL: base, deviceSigner: signer, transport: t, clock: { 1763750000 })
        let code = try await c.startEnrollment(name: "iPhone")
        XCTAssertEqual(code.userCode, "BCDF-GHJK")
        let body = bodyJSON(t.requests[0])
        XCTAssertEqual(body["device_id"], .string(deviceID))
        XCTAssertEqual(body["time"], 1763750000)
        let proof = Encoding.base64urlDecode(body["proof"]!.stringValue!)!
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: signer.publicKey)
        XCTAssertTrue(pub.isValidSignature(proof, for: Data("subetha-enroll-v1\n\(deviceID)\n1763750000".utf8)))
        let account = try await c.awaitEnrollment(code)
        XCTAssertEqual(account, "acct_1")
    }
    #endif
}
