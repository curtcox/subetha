import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// SubEtha client: publish, dry-run estimates, poll, and subscribe with reconnect, dedupe and
/// acks. Mirrors the TypeScript reference client (`sdk/js/src/client.ts`) and the Kotlin SDK.
///
/// ```swift
/// let client = SubEtha(token: "se_…")
/// try await client.publish("@me/doorbell", "ding", PublishOptions(title: "Front door"))
/// for try await m in client.messages(["@me/doorbell"]) { print(m.message ?? "") }
/// ```
public final class SubEtha: @unchecked Sendable {
    public static let defaultBaseURL = URL(string: "https://subetha.us")!
    public static let version = "0.1.0"

    public let baseURL: URL
    private let token: String?
    private let deviceSigner: DeviceSigner?
    private let signRequests: Bool
    private let crypto: EnvelopeCrypto?
    private let topicKeys: [String: TopicKey]
    private let transport: HTTPTransport
    private let clock: @Sendable () -> Int64

    /// - Parameters:
    ///   - signRequests: authenticate with the device signature instead of the bearer token
    ///     (enrolled devices; see `startEnrollment`).
    ///   - crypto: signature checks and E2EE, from `SubEthaCore`.
    ///   - clock: unix seconds; replaceable in tests.
    public init(baseURL: URL = SubEtha.defaultBaseURL,
                token: String? = nil,
                deviceSigner: DeviceSigner? = nil,
                signRequests: Bool = false,
                crypto: EnvelopeCrypto? = nil,
                topicKeys: [String: TopicKey] = [:],
                transport: HTTPTransport = URLSessionTransport(),
                clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) }) {
        precondition(!signRequests || deviceSigner != nil, "signRequests needs a deviceSigner")
        precondition(topicKeys.isEmpty || crypto != nil, "topicKeys need an EnvelopeCrypto (SubEthaCore)")
        var s = baseURL.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        self.baseURL = URL(string: s)!
        self.token = token
        self.deviceSigner = deviceSigner
        self.signRequests = signRequests
        self.crypto = crypto
        self.topicKeys = topicKeys
        self.transport = transport
        self.clock = clock
    }

    // MARK: - HTTP

    private func makeRequest(_ method: String, _ url: URL, body: Data? = nil, headers: [String: String] = [:], streaming: Bool = false) throws -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.httpBody = body
        r.timeoutInterval = streaming ? 90 : 30
        r.setValue("subetha-swift/\(SubEtha.version)", forHTTPHeaderField: "User-Agent")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        if signRequests, let signer = deviceSigner {
            let sent = r.allHTTPHeaderFields ?? [:]
            for (k, v) in try RequestSigning.headers(signer: signer, method: method, url: url, body: body ?? Data(), time: clock(), headers: sent) {
                r.setValue(v, forHTTPHeaderField: k)
            }
        } else if let token {
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return r
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, resp) = try await transport.data(for: request)
        guard (200..<300).contains(resp.statusCode) else {
            throw SubEthaError.from(status: resp.statusCode, data: data, retryAfter: resp.value(forHTTPHeaderField: "Retry-After"))
        }
        return data
    }

    /// Any JSON API call: `try await client.request("GET", "/v1/balance")`.
    @discardableResult
    public func request(_ method: String, _ path: String, body: JSONValue? = nil, headers: [String: String] = [:]) async throws -> JSONValue {
        var h = headers
        var data: Data?
        if let body {
            data = Data(body.jsonString().utf8)
            h["Content-Type"] = "application/json"
        }
        let url = URL(string: baseURL.absoluteString + path)!
        let out = try await send(try makeRequest(method, url, body: data, headers: h))
        if out.isEmpty || String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .object([:]) }
        return try JSONValue.parse(out)
    }

    private func requestObject(_ method: String, _ path: String, body: JSONValue? = nil, headers: [String: String] = [:]) async throws -> [String: JSONValue] {
        guard let o = try await request(method, path, body: body, headers: headers).objectValue else {
            throw SubEthaClientError.invalidResponse("expected a JSON object from \(path)")
        }
        return o
    }

    // MARK: - Publish

    /// The envelope `publish` would send, signed and/or encrypted as configured.
    public func buildEnvelope(_ topic: String, _ message: String, _ o: PublishOptions = PublishOptions()) throws -> [String: JSONValue] {
        var env = o.extra
        env["topic"] = .string(topic)
        env["message"] = .string(message)
        if let v = o.title { env["title"] = .string(v) }
        if let v = o.priority, v != 3 { env["priority"] = .int(Int64(v)) }
        if !o.tags.isEmpty { env["tags"] = .array(o.tags.map(JSONValue.string)) }
        if let v = o.click { env["click"] = .string(v) }
        if let v = o.icon { env["icon"] = .string(v) }
        if let v = o.contentType { env["content_type"] = .string(v) }
        if !o.actions.isEmpty { env["actions"] = .array(o.actions.map(JSONValue.object)) }
        if let v = o.expires { env["expires"] = .int(v) }
        if let v = o.hops { env["hops"] = .int(Int64(v)) }
        if let r = o.route {
            var route: [String: JSONValue] = [:]
            if let m = r.mode { route["mode"] = .string(m.rawValue) }
            if let c = r.maxCostUSD { route["max_cost_usd_micros"] = .int(Int64((c * 1e6).rounded(.down))) }
            if !r.deny.isEmpty { route["deny"] = .array(r.deny.map(JSONValue.string)) }
            if !r.allow.isEmpty { route["allow"] = .array(r.allow.map(JSONValue.string)) }
            if let d = r.deadlineSeconds { route["deadline_s"] = .int(Int64(d)) }
            env["route"] = .object(route)
        }
        let topicKey = topicKeys[topic]
        let sign = o.sign ?? (deviceSigner != nil)
        let encrypt = o.encrypt ?? (topicKey != nil)
        if sign || encrypt {
            env["id"] = .string(ULID.make())
            env["time"] = .int(clock())
        }
        if encrypt {
            guard let k = topicKey else { throw SubEthaClientError.missingTopicKey(topic) }
            guard let crypto else { throw SubEthaClientError.missingCrypto }
            env = try Self.object(crypto.encrypt(JSONValue.object(env).jsonString(), key: k.key, kid: k.kid))
        }
        if sign {
            guard let signer = deviceSigner else { throw SubEthaClientError.missingDeviceSigner }
            env = try Self.object(signer.signEnvelope(JSONValue.object(env).jsonString()))
        }
        return env
    }

    /// Publishes a message; returns the stored envelope as the relay saw it.
    @discardableResult
    public func publish(_ topic: String, _ message: String, _ options: PublishOptions = PublishOptions()) async throws -> Message {
        let env = try buildEnvelope(topic, message, options)
        let headers = options.idempotencyKey.map { ["Idempotency-Key": $0] } ?? [:]
        return Message(json: try await requestObject("POST", "/", body: .object(env), headers: headers))
    }

    /// Publishes an envelope exactly as given: one built elsewhere, or one that arrived over an
    /// edge link (signatures and E2EE stay intact; the relay drops it as a duplicate by id).
    @discardableResult
    public func publishEnvelope(_ envelope: [String: JSONValue], idempotencyKey: String? = nil) async throws -> Message {
        var env = envelope
        env["event"] = nil
        let headers = idempotencyKey.map { ["Idempotency-Key": $0] } ?? [:]
        return Message(json: try await requestObject("POST", "/", body: .object(env), headers: headers))
    }

    /// Dry run: who would get it, how, and the worst-case cost. Nothing is delivered.
    public func estimate(_ topic: String, _ message: String, _ options: PublishOptions = PublishOptions()) async throws -> Estimate {
        let env = try buildEnvelope(topic, message, options)
        return Estimate(json: try await requestObject("POST", "/", body: .object(env), headers: ["X-Dry-Run": "1"]))
    }

    private func fileHeaders(filename: String, contentType: String, message: String?, options: PublishOptions, extra: [String: String] = [:]) -> [String: String] {
        var h: [String: String] = ["Content-Type": contentType, "X-Filename": filename]
        if let m = message { h["X-Message"] = m }
        if let v = options.title { h["X-Title"] = v }
        if let v = options.priority, v != 3 { h["X-Priority"] = String(v) }
        if !options.tags.isEmpty { h["X-Tags"] = options.tags.joined(separator: ",") }
        if let v = options.click { h["X-Click"] = v }
        if let v = options.icon { h["X-Icon"] = v }
        if !options.actions.isEmpty { h["X-Actions"] = JSONValue.array(options.actions.map(JSONValue.object)).jsonString() }
        if options.contentType == "text/markdown" { h["X-Markdown"] = "1" }
        else if let ct = options.contentType { h["X-Content-Type"] = ct }
        if let v = options.expires { h["X-Expires"] = String(v) }
        if let v = options.hops { h["X-Hops"] = String(v) }
        if let r = options.route {
            if let m = r.mode { h["X-Route-Mode"] = m.rawValue }
            if let c = r.maxCostUSD { h["X-Max-Cost"] = String(c) }
            if !r.deny.isEmpty { h["X-Deny"] = r.deny.joined(separator: ",") }
            if !r.allow.isEmpty { h["X-Allow"] = r.allow.joined(separator: ",") }
            if let d = r.deadlineSeconds { h["X-Deadline"] = String(d) }
        }
        if let k = options.idempotencyKey { h["Idempotency-Key"] = k }
        for (k, v) in extra { h[k] = v }
        return h
    }

    /// Publishes a file attachment uploaded to R2 (`PUT /<topic>` with `X-Filename`).
    @discardableResult
    public func publishFile(_ topic: String, filename: String, data: Data, contentType: String = "application/octet-stream", message: String? = nil, options: PublishOptions = PublishOptions()) async throws -> Message {
        let url = URL(string: baseURL.absoluteString + "/" + Self.topicPath([topic]))!
        let h = fileHeaders(filename: filename, contentType: contentType, message: message, options: options)
        let out = try await send(try makeRequest("PUT", url, body: data, headers: h))
        guard let obj = try JSONValue.parse(out).objectValue else { throw SubEthaClientError.invalidResponse("expected a JSON object") }
        return Message(json: obj)
    }

    /// Dry run for a file-attachment publish.
    public func estimateFile(_ topic: String, filename: String, data: Data, contentType: String = "application/octet-stream", message: String? = nil, options: PublishOptions = PublishOptions()) async throws -> Estimate {
        let url = URL(string: baseURL.absoluteString + "/" + Self.topicPath([topic]))!
        let h = fileHeaders(filename: filename, contentType: contentType, message: message, options: options, extra: ["X-Dry-Run": "1"])
        let out = try await send(try makeRequest("PUT", url, body: data, headers: h))
        guard let obj = try JSONValue.parse(out).objectValue else { throw SubEthaClientError.invalidResponse("expected a JSON object") }
        return Estimate(json: obj)
    }

    // MARK: - Receive

    static func topicPath(_ topics: [String]) -> String {
        precondition(!topics.isEmpty, "at least one topic is required")
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/,?#")
        return topics.map { t in
            t.split(separator: "/", omittingEmptySubsequences: false)
                .map { String($0).addingPercentEncoding(withAllowedCharacters: allowed) ?? String($0) }
                .joined(separator: "/")
        }.joined(separator: ",")
    }

    private func subscribeURL(_ topics: [String], since: String?, priority: [Int], tags: [String], poll: Bool) -> URL {
        var c = URLComponents(string: baseURL.absoluteString)!
        c.percentEncodedPath = c.percentEncodedPath + "/" + Self.topicPath(topics) + "/json"
        var q: [URLQueryItem] = []
        if poll { q.append(URLQueryItem(name: "poll", value: "1")) }
        if let since { q.append(URLQueryItem(name: "since", value: since)) }
        if !priority.isEmpty { q.append(URLQueryItem(name: "priority", value: priority.map(String.init).joined(separator: ","))) }
        if !tags.isEmpty { q.append(URLQueryItem(name: "tags", value: tags.joined(separator: ","))) }
        c.queryItems = q.isEmpty ? nil : q
        return c.url!
    }

    /// Cached messages (since defaults to `all`).
    public func poll(_ topics: [String], since: String = "all", priority: [Int] = [], tags: [String] = []) async throws -> [Message] {
        try await pollRaw(topics, since: since, priority: priority, tags: tags).map(receive)
    }

    private func pollRaw(_ topics: [String], since: String, priority: [Int], tags: [String]) async throws -> [[String: JSONValue]] {
        let url = subscribeURL(topics, since: since, priority: priority, tags: tags, poll: true)
        let data = try await send(try makeRequest("GET", url))
        return String(decoding: data, as: UTF8.self)
            .split(whereSeparator: \.isNewline)
            .compactMap { try? JSONValue.parse(String($0)).objectValue }
    }

    /// Acknowledges a message so escalation stops.
    public func ack(topic: String, id: String, via: String = "http") async throws {
        try await request("POST", "/v1/ack", body: ["topic": .string(topic), "id": .string(id), "via": .string(via)])
    }

    private func receive(_ env: [String: JSONValue]) -> Message {
        if env["enc"] != nil, let topic = env["topic"]?.stringValue, let key = topicKeys[topic], let crypto,
           let dec = crypto.decrypt(JSONValue.object(env).jsonString(), key: key.key), let obj = try? Self.object(dec) {
            return Message(json: obj)
        }
        return Message(json: env)
    }

    /// Subscribes and calls `handler` for each message until the task is cancelled. Reconnects
    /// with exponential backoff, resuming from the last id; drops duplicates; decrypts; acks
    /// each message after `handler` returns.
    ///
    /// Client errors that retrying can't fix (401, 402, 403, 404, …) are thrown; network
    /// errors, 408, 429 and 5xx reconnect.
    public func subscribe(_ topics: [String], options: SubscribeOptions = SubscribeOptions(),
                          handler: @escaping @Sendable (Message) async throws -> Void) async throws {
        if (options.verify || options.requireSignature) && crypto == nil { throw SubEthaClientError.missingCrypto }
        var dedupe = Deduper()
        var since = options.since
        var backoff = options.initialBackoff
        let via = options.transport == .poll ? "poll" : "stream"

        func handle(_ raw: [String: JSONValue]) async throws {
            if let event = raw["event"]?.stringValue, event != "message" {
                if event == "open" {
                    backoff = options.initialBackoff
                    options.onOpen?()
                }
                return
            }
            guard dedupe.accept(raw, now: clock()) else { return }
            if let id = raw["id"]?.stringValue { since = id }
            if options.verify || options.requireSignature {
                if raw["sig"] != nil {
                    if !(crypto?.verify(JSONValue.object(raw).jsonString()) ?? false) { return }
                } else if options.requireSignature { return }
            }
            let m = options.raw ? Message(json: raw) : receive(raw)
            try await handler(m)
            if options.autoAck, let id = m.id {
                do { try await ack(topic: m.topic, id: id, via: via) } catch { options.onError?(error) }
            }
        }

        while true {
            try Task.checkCancellation()
            do {
                if options.transport == .poll {
                    for raw in try await pollRaw(topics, since: since ?? "all", priority: options.priority, tags: options.tags) {
                        try await handle(raw)
                    }
                    if since == nil { since = String(clock()) }
                    backoff = options.initialBackoff
                    try await Task.sleep(nanoseconds: UInt64(options.pollInterval * 1e9))
                    continue
                }
                let url = subscribeURL(topics, since: since, priority: options.priority, tags: options.tags, poll: false)
                let (lines, resp) = try await transport.lines(for: try makeRequest("GET", url, streaming: true))
                guard (200..<300).contains(resp.statusCode) else {
                    var body = ""
                    for try await l in lines { body += l + "\n" }
                    throw SubEthaError.from(status: resp.statusCode, data: Data(body.utf8), retryAfter: resp.value(forHTTPHeaderField: "Retry-After"))
                }
                for try await line in lines {
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    if trimmed.isEmpty { continue }
                    guard let raw = try? JSONValue.parse(trimmed).objectValue else { continue }
                    try await handle(raw)
                }
                throw URLError(.networkConnectionLost)
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                if let e = error as? SubEthaError, (400..<500).contains(e.status), e.status != 408, e.status != 429 { throw e }
                if error is SubEthaClientError { throw error }
                options.onError?(error)
                let wait = (error as? SubEthaError)?.retryAfter ?? backoff
                try await Task.sleep(nanoseconds: UInt64(wait * 1e9))
                backoff = min(backoff * 2, options.maxBackoff)
            }
        }
    }

    /// `subscribe` as an `AsyncThrowingStream`. Ending the `for try await` loop (or cancelling
    /// its task) closes the connection. Messages are acked once yielded to the stream.
    public func messages(_ topics: [String], options: SubscribeOptions = SubscribeOptions()) -> AsyncThrowingStream<Message, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await self.subscribe(topics, options: options) { message in
                        _ = continuation.yield(message)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Devices

    /// Step 1 of device enrollment: registers this device's key and returns a code the user
    /// approves in the console (`verificationURIComplete`).
    public func startEnrollment(name: String? = nil, capabilities: [String] = []) async throws -> DeviceCode {
        guard let signer = deviceSigner else { throw SubEthaClientError.missingDeviceSigner }
        let p = try RequestSigning.enrollmentProof(signer: signer, time: clock())
        var body: [String: JSONValue] = ["device_id": .string(p.deviceId), "time": .int(p.time), "proof": .string(p.proof)]
        if let name { body["name"] = .string(name) }
        if !capabilities.isEmpty { body["capabilities"] = .array(capabilities.map(JSONValue.string)) }
        let r = try await requestObject("POST", "/v1/device/code", body: .object(body))
        return DeviceCode(deviceCode: r["device_code"]?.stringValue ?? "", userCode: r["user_code"]?.stringValue ?? "",
                          verificationURI: r["verification_uri"]?.stringValue ?? "",
                          verificationURIComplete: r["verification_uri_complete"]?.stringValue ?? "",
                          expiresIn: r["expires_in"]?.intValue ?? 0, interval: r["interval"]?.intValue ?? 5)
    }

    /// Step 2: polls until the user approves (returns the account id) or the code expires (throws).
    public func awaitEnrollment(_ code: DeviceCode) async throws -> String {
        while true {
            do {
                let r = try await requestObject("POST", "/v1/device/token", body: ["device_code": .string(code.deviceCode)])
                return r["account_id"]?.stringValue ?? ""
            } catch let e as SubEthaError where e.code == "authorization_pending" {
                try await Task.sleep(nanoseconds: UInt64(max(code.interval, 1)) * 1_000_000_000)
            }
        }
    }

    // MARK: - Control plane

    private static func q(_ s: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    public func account() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/account") }
    public func updateAccount(_ patch: [String: JSONValue]) async throws -> [String: JSONValue] { try await requestObject("PATCH", "/v1/account", body: .object(patch)) }
    public func balance() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/balance") }
    public func prices() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/prices") }
    public func trace(topic: String, id: String) async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/traces/\(Self.q(id))?topic=\(Self.q(topic))") }
    public func ledger(after: Int64 = 0, limit: Int = 100) async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/ledger?after=\(after)&limit=\(limit)") }
    public func usage(days: Int = 30) async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/usage?days=\(days)") }
    public func audit(limit: Int = 50) async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/audit?limit=\(limit)") }
    public func topics() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/topics") }
    public func topic(_ name: String) async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/topics/\(Self.topicPath([name]))") }
    public func createTopic(_ name: String, policy: [String: JSONValue] = [:]) async throws -> [String: JSONValue] { try await requestObject("PUT", "/v1/topics/\(Self.topicPath([name]))", body: ["policy": .object(policy)]) }
    public func deleteTopic(_ name: String) async throws -> [String: JSONValue] { try await requestObject("DELETE", "/v1/topics/\(Self.topicPath([name]))") }
    public func devices() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/devices") }
    public func updateDevice(_ id: String, _ patch: [String: JSONValue]) async throws -> [String: JSONValue] { try await requestObject("PATCH", "/v1/devices/\(Self.q(id))", body: .object(patch)) }
    public func revokeDevice(_ id: String) async throws -> [String: JSONValue] { try await requestObject("DELETE", "/v1/devices/\(Self.q(id))") }
    public func endpoints() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/endpoints") }
    public func deleteEndpoint(_ id: String) async throws -> [String: JSONValue] { try await requestObject("DELETE", "/v1/endpoints/\(Self.q(id))") }
    public func subscriptions() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/subscriptions") }
    public func deleteSubscription(_ id: String) async throws -> [String: JSONValue] { try await requestObject("DELETE", "/v1/subscriptions/\(Self.q(id))") }
    public func tokens() async throws -> [String: JSONValue] { try await requestObject("GET", "/v1/tokens") }
    public func revokeToken(_ id: String) async throws -> [String: JSONValue] { try await requestObject("DELETE", "/v1/tokens/\(Self.q(id))") }
    public func listWrappedKeys(topic: String? = nil) async throws -> [String: JSONValue] {
        try await requestObject("GET", topic.map { "/v1/keys?topic=\(Self.q($0))" } ?? "/v1/keys")
    }
    public func deleteWrappedKeys(topic: String, kid: String? = nil, device: String? = nil) async throws -> [String: JSONValue] {
        var qs = ["topic=\(Self.q(topic))"]
        if let kid { qs.append("kid=\(Self.q(kid))") }
        if let device { qs.append("device=\(Self.q(device))") }
        return try await requestObject("DELETE", "/v1/keys?\(qs.joined(separator: "&"))")
    }

    // MARK: - Helpers

    static func object(_ json: String) throws -> [String: JSONValue] {
        guard let o = try JSONValue.parse(json).objectValue else { throw SubEthaClientError.invalidResponse("expected a JSON object") }
        return o
    }
}

/// Seen-id LRU (spec §6). Ids compare case-insensitively; expired messages are dropped.
struct Deduper {
    private var seen = Set<String>()
    private var order: [String] = []
    private let capacity: Int

    init(capacity: Int = 10_000) { self.capacity = capacity }

    mutating func accept(_ env: [String: JSONValue], now: Int64) -> Bool {
        if let exp = env["expires"]?.intValue, exp < now { return false }
        guard let id = env["id"]?.stringValue?.uppercased() else { return true }
        if seen.contains(id) { return false }
        seen.insert(id)
        order.append(id)
        if order.count > capacity { seen.remove(order.removeFirst()) }
        return true
    }
}
