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

    func testPublishEnvelopeForwardsItUnchanged() async throws {
        let t = MockTransport { r, _ in .init(body: String(decoding: r.httpBody!, as: UTF8.self)) }
        let c = SubEtha(baseURL: base, token: "se_t", transport: t)
        let env: [String: JSONValue] = ["id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "topic": "@a/b", "message": "hi", "event": "message", "hops": 1, "sig": "ed25519:x"]
        try await c.publishEnvelope(env, idempotencyKey: "k")
        let r = t.requests[0]
        XCTAssertEqual(r.value(forHTTPHeaderField: "Idempotency-Key"), "k")
        XCTAssertEqual(bodyJSON(r), ["id": "01JD5A2Z3K8Q9V6X7W4T1R0S2M", "topic": "@a/b", "message": "hi", "hops": 1, "sig": "ed25519:x"])
    }

    func testRequestSigningInput() {
        let nonce = "nonce_0123456789abcdef"
        let signed = RequestSigning.headersToSign(deviceId: deviceID, time: 1763750000, nonce: nonce,
                                                  headers: ["X-Title": " Door ", "Authorization": "x", "User-Agent": "u", "Content-Type": "text/plain"])
        XCTAssertEqual(signed.map { $0.0 }.joined(separator: ","), "x-device-id,x-device-time,x-device-nonce,content-type,x-title")
        // Same string as the TypeScript reference (spec §8.1).
        XCTAssertEqual(RequestSigning.input(method: "post", url: URL(string: "https://x.test/v1/ack?x=1")!, body: Data("{}".utf8), signedHeaders: signed),
                       "subetha-req-v2\nPOST\nx.test\n/v1/ack?x=1\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\nx-device-id:\(deviceID)\nx-device-time:1763750000\nx-device-nonce:\(nonce)\ncontent-type:text/plain\nx-title:Door")
        // Host as WHATWG URL.host: lowercase, default port dropped, other ports kept.
        XCTAssertEqual(RequestSigning.input(method: "GET", url: URL(string: "https://X.test:443")!, body: Data(), signedHeaders: []),
                       "subetha-req-v2\nGET\nx.test\n/\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertTrue(RequestSigning.input(method: "GET", url: URL(string: "http://127.0.0.1:8080/a%20b?q=1")!, body: Data(), signedHeaders: [])
            .hasPrefix("subetha-req-v2\nGET\n127.0.0.1:8080\n/a%20b?q=1\n"))
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
        // Verify the way the relay does: every listed header, with its value as sent.
        let listed = try XCTUnwrap(r.value(forHTTPHeaderField: "X-Device-Signed-Headers")).split(separator: ",").map(String.init)
        XCTAssertEqual(listed, ["x-device-id", "x-device-time", "x-device-nonce", "content-type"])
        let input = RequestSigning.input(method: "POST", url: r.url!, body: r.httpBody!, signedHeaders: listed.map { ($0, r.value(forHTTPHeaderField: $0)!) })
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: signer.publicKey)
        let sig = Encoding.base64urlDecode(r.value(forHTTPHeaderField: "X-Device-Signature")!)!
        XCTAssertTrue(pub.isValidSignature(sig, for: Data(input.utf8)))
        XCTAssertThrowsError(try signer.signEnvelope("{}"))
    }

    func testDBADeviceAttachesKeyAndLinks() async throws {
        struct FakeDBA: DBAHeaders {
            func headers(method: String, url: URL) async throws -> [String: String] {
                ["Authorization": "DBA cred", "DPoP": "proof:\(method):\(url.absoluteString)"]
            }
        }
        let t = MockTransport { r, _ in
            if r.url!.path == "/v1/devices/dba" { return .init(status: 201, body: #"{"id":"\#(deviceID)","enrolled":true,"dba_device":"dba:d1"}"#) }
            if r.url!.path == "/v1/dba/link", r.httpMethod == "GET" { return .init(body: #"{"linked":true,"dba_account":"a1","linked_at":1,"issuer":"https://devicebasedauth.org","audience":"subetha.us"}"#) }
            return .init(body: #"{"linked":false}"#)
        }
        let signer = try CryptoKitDeviceSigner(seed: Encoding.hexDecode(seedHex)!)
        let c = SubEtha(baseURL: base, token: "se_ignored", deviceSigner: signer, dba: FakeDBA(), transport: t, clock: { 1763750000 })
        let r = try await c.attachDeviceKey(name: "iPhone", capabilities: ["ws"])
        XCTAssertEqual(r["dba_device"], .string("dba:d1"))
        let req = t.requests[0]
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "DBA cred")
        XCTAssertEqual(req.value(forHTTPHeaderField: "DPoP"), "proof:POST:https://x.test/v1/devices/dba")
        XCTAssertNil(req.value(forHTTPHeaderField: "X-Device-Signature"))
        let body = bodyJSON(req)
        XCTAssertEqual(body["device_id"], .string(deviceID))
        XCTAssertEqual(body["time"], 1763750000)
        XCTAssertEqual(body["name"], .string("iPhone"))
        let proof = Encoding.base64urlDecode(body["proof"]!.stringValue!)!
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: signer.publicKey)
        XCTAssertTrue(pub.isValidSignature(proof, for: Data("subetha-enroll-v1\n\(deviceID)\n1763750000".utf8)))
        let link = try await c.dbaLink()
        XCTAssertEqual(link["dba_account"], .string("a1"))
        _ = try await c.unlinkDba()
        XCTAssertEqual(t.requests.last?.httpMethod, "DELETE")
        XCTAssertEqual(t.requests.last?.url?.path, "/v1/dba/link")
    }
    #endif

    func testContentTypeActionsFileUploadAndControlPlane() async throws {
        let t = MockTransport { r, _ in
            if r.httpMethod == "PUT", r.value(forHTTPHeaderField: "X-Dry-Run") == "1" {
                return .init(body: #"{"dry_run":true,"estimate_usd_micros":25,"plan":[]}"#)
            }
            if r.httpMethod == "PUT" {
                return .init(body: #"{"id":"01F","topic":"@a/b","message":"snap","attachment":{"name":"snap.jpg","url":"https://x.test/file/1/snap.jpg","size":3}}"#)
            }
            return .init(body: r.httpBody.flatMap { $0.isEmpty ? nil : String(decoding: $0, as: UTF8.self) } ?? "{}")
        }
        let c = SubEtha(baseURL: base, token: "se_t", transport: t)
        let m = try await c.publish("@a/b", "**hi**", PublishOptions(
            icon: "https://x.test/i.png",
            contentType: "text/markdown",
            actions: [["action": "view", "label": "Open", "url": "https://x.test"]],
            hops: 2
        ))
        XCTAssertEqual(m.contentType, "text/markdown")
        XCTAssertEqual(m.icon, "https://x.test/i.png")
        XCTAssertEqual(m.hops, 2)
        XCTAssertEqual(m.actions.first?["label"], "Open")
        XCTAssertTrue(SubscribeOptions(raw: true).raw)

        let uploaded = try await c.publishFile("@a/b", filename: "snap.jpg", data: Data([1, 2, 3]), contentType: "image/jpeg", message: "snap",
                                               options: PublishOptions(title: "Door", route: Route(allow: ["ws", "sms"], deadlineSeconds: 30)))
        XCTAssertEqual(uploaded.attachment?["name"], "snap.jpg")
        let putReq = t.requests[1]
        XCTAssertEqual(putReq.httpMethod, "PUT")
        XCTAssertEqual(pathAndQuery(putReq), "/@a/b")
        XCTAssertEqual(putReq.value(forHTTPHeaderField: "X-Filename"), "snap.jpg")
        XCTAssertEqual(putReq.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
        XCTAssertEqual(putReq.value(forHTTPHeaderField: "X-Allow"), "ws,sms")
        XCTAssertEqual(putReq.value(forHTTPHeaderField: "X-Deadline"), "30")

        let est = try await c.estimateFile("@a/b", filename: "snap.jpg", data: Data([1, 2, 3]), contentType: "image/jpeg")
        XCTAssertEqual(est.estimateUSDMicros, 25)

        _ = try await c.trace(topic: "@a/b", id: "01F")
        XCTAssertEqual(pathAndQuery(t.requests[3]), "/v1/traces/01F?topic=@a/b")
        _ = try await c.topics()
        _ = try await c.createTopic("@a/b", policy: ["paused": false])
        _ = try await c.deleteTopic("@a/b")
        _ = try await c.devices()
        _ = try await c.usage(days: 7)
        _ = try await c.listWrappedKeys(topic: "@a/b")
        _ = try await c.deleteWrappedKeys(topic: "@a/b", kid: "k1")
        XCTAssertEqual(t.requests.last?.httpMethod, "DELETE")
        XCTAssertEqual(pathAndQuery(t.requests.last!), "/v1/keys?topic=@a/b&kid=k1")
    }
}
