import Foundation

/// A message envelope (spec §2) with typed accessors. All fields stay in `json`.
public struct Message: Equatable, Sendable, CustomStringConvertible {
    public let json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }

    public var id: String? { json["id"]?.stringValue }
    public var time: Int64? { json["time"]?.intValue }
    public var topic: String { json["topic"]?.stringValue ?? "" }
    public var message: String? { json["message"]?.stringValue }
    public var title: String? { json["title"]?.stringValue }
    /// 1–5; absent means 3.
    public var priority: Int { json["priority"]?.intValue.map(Int.init) ?? 3 }
    public var tags: [String] { json["tags"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    public var click: String? { json["click"]?.stringValue }
    public var icon: String? { json["icon"]?.stringValue }
    public var contentType: String? { json["content_type"]?.stringValue }
    public var hops: Int? { json["hops"]?.intValue.map(Int.init) }
    public var attachment: [String: JSONValue]? { json["attachment"]?.objectValue }
    public var actions: [[String: JSONValue]] { json["actions"]?.arrayValue?.compactMap(\.objectValue) ?? [] }
    public var expires: Int64? { json["expires"]?.intValue }
    /// `message` for messages; `open` / `keepalive` for stream control events.
    public var event: String? { json["event"]?.stringValue }
    public var sender: String? { json["sender"]?.stringValue }
    public var isSigned: Bool { json["sig"] != nil }
    /// Still encrypted (no topic key configured, or the wrong one).
    public var isEncrypted: Bool { json["enc"] != nil }

    public subscript(key: String) -> JSONValue? { json[key] }

    public func jsonString() -> String { JSONValue.object(json).jsonString() }

    public var description: String { "Message(\(jsonString()))" }
}

public enum RouteMode: String, Sendable { case any, fast, all, cheap }

/// Per-message routing (spec §2 `route`). Transports are names like `ws`, `webpush`, `sms`.
public struct Route: Equatable, Sendable {
    public var mode: RouteMode?
    /// Worst-case spend for this message, in US dollars.
    public var maxCostUSD: Double?
    public var deny: [String]
    public var allow: [String]
    public var deadlineSeconds: Int?

    public init(mode: RouteMode? = nil, maxCostUSD: Double? = nil, deny: [String] = [], allow: [String] = [], deadlineSeconds: Int? = nil) {
        self.mode = mode
        self.maxCostUSD = maxCostUSD
        self.deny = deny
        self.allow = allow
        self.deadlineSeconds = deadlineSeconds
    }
}

public struct PublishOptions: Sendable {
    public var title: String?
    /// 1 (min) … 5 (max).
    public var priority: Int?
    public var tags: [String]
    public var click: String?
    public var icon: String?
    public var contentType: String?
    public var actions: [[String: JSONValue]]
    /// Unix seconds.
    public var expires: Int64?
    public var hops: Int?
    public var route: Route?
    public var idempotencyKey: String?
    /// Sign with the client's device signer. Default: when a signer is configured.
    public var sign: Bool?
    /// Encrypt with the topic key. Default: when a key for the topic is configured.
    public var encrypt: Bool?
    /// Extension fields merged into the envelope (spec §2.2).
    public var extra: [String: JSONValue]

    public init(title: String? = nil, priority: Int? = nil, tags: [String] = [], click: String? = nil, icon: String? = nil,
                contentType: String? = nil, actions: [[String: JSONValue]] = [],
                expires: Int64? = nil, hops: Int? = nil, route: Route? = nil, idempotencyKey: String? = nil,
                sign: Bool? = nil, encrypt: Bool? = nil, extra: [String: JSONValue] = [:]) {
        self.title = title
        self.priority = priority
        self.tags = tags
        self.click = click
        self.icon = icon
        self.contentType = contentType
        self.actions = actions
        self.expires = expires
        self.hops = hops
        self.route = route
        self.idempotencyKey = idempotencyKey
        self.sign = sign
        self.encrypt = encrypt
        self.extra = extra
    }
}

/// Dry-run result: route plan and worst-case cost. Nothing was delivered.
public struct Estimate: Sendable {
    public let json: [String: JSONValue]
    public var estimateUSDMicros: Int64 { json["estimate_usd_micros"]?.intValue ?? 0 }
    public var estimateUSD: Double { Double(estimateUSDMicros) / 1e6 }
    /// One entry per planned delivery step (transport, cost, latency, …).
    public var plan: [[String: JSONValue]] { json["plan"]?.arrayValue?.compactMap(\.objectValue) ?? [] }
    public var message: Message? { json["message"]?.objectValue.map(Message.init(json:)) }
}

public enum SubscribeTransport: Sendable { case stream, poll }

public struct SubscribeOptions: Sendable {
    /// `all`, a duration like `10m`, a unix time, or a message id. Default: new messages only.
    public var since: String?
    public var priority: [Int]
    public var tags: [String]
    public var transport: SubscribeTransport
    public var pollInterval: TimeInterval
    /// Ack each message after the handler returns (stops escalation).
    public var autoAck: Bool
    /// Drop messages whose signature fails (needs an `EnvelopeCrypto`).
    public var verify: Bool
    /// Also drop unsigned messages.
    public var requireSignature: Bool
    /// Pass envelopes through as received (no E2EE decryption), e.g. to forward them.
    public var raw: Bool = false
    public var initialBackoff: TimeInterval
    public var maxBackoff: TimeInterval
    /// Called on each (re)connect.
    public var onOpen: (@Sendable () -> Void)?
    /// Called with each error that triggers a reconnect.
    public var onError: (@Sendable (Error) -> Void)?

    public init(since: String? = nil, priority: [Int] = [], tags: [String] = [], transport: SubscribeTransport = .stream,
                pollInterval: TimeInterval = 5, autoAck: Bool = true, verify: Bool = false, requireSignature: Bool = false,
                raw: Bool = false,
                initialBackoff: TimeInterval = 0.5, maxBackoff: TimeInterval = 30,
                onOpen: (@Sendable () -> Void)? = nil, onError: (@Sendable (Error) -> Void)? = nil) {
        self.since = since
        self.priority = priority
        self.tags = tags
        self.transport = transport
        self.pollInterval = pollInterval
        self.autoAck = autoAck
        self.verify = verify
        self.requireSignature = requireSignature
        self.raw = raw
        self.initialBackoff = initialBackoff
        self.maxBackoff = maxBackoff
        self.onOpen = onOpen
        self.onError = onError
    }
}

/// Device-code enrollment (RFC 8628-style), from `POST /v1/device/code`.
public struct DeviceCode: Equatable, Sendable {
    public let deviceCode: String
    public let userCode: String
    public let verificationURI: String
    public let verificationURIComplete: String
    public let expiresIn: Int64
    public let interval: Int64
}

/// An E2EE topic key (spec §5): 32 bytes plus its key id.
public struct TopicKey: Sendable {
    public let kid: String
    public let key: Data
    public init(kid: String, key: Data) {
        precondition(key.count == 32, "topic keys are 32 bytes")
        self.kid = kid
        self.key = key
    }
}
