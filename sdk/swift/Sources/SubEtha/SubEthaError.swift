import Foundation

/// An error response from the relay (spec §9). `code` is the stable machine-readable code
/// (`insufficient_balance`, `rate_limited`, …; see spec/errors.json), `status` the HTTP status,
/// and `body` the full JSON error body.
public struct SubEthaError: Error, LocalizedError, Equatable, Sendable {
    public let code: String
    public let status: Int
    public let message: String
    public let body: [String: JSONValue]
    /// Seconds from `Retry-After`, if sent.
    public let retryAfter: Double?

    public init(code: String, status: Int, message: String = "", body: [String: JSONValue] = [:], retryAfter: Double? = nil) {
        self.code = code
        self.status = status
        self.message = message
        self.body = body
        self.retryAfter = retryAfter
    }

    /// Worth retrying later: rate limits and server-side failures.
    public var retryable: Bool { status == 429 || status >= 500 }

    public var errorDescription: String? { message.isEmpty ? "\(code) (HTTP \(status))" : "\(code) (HTTP \(status)): \(message)" }

    private static let statusCodes: [Int: String] = [
        400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict",
        413: "message_too_large", 429: "rate_limited", 500: "internal", 503: "provider_unavailable",
    ]

    static func from(status: Int, data: Data, retryAfter: String?) -> SubEthaError {
        let ra = retryAfter.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        let obj = (try? JSONValue.parse(data))?.objectValue
        if let obj, let code = obj["error"]?.stringValue {
            return SubEthaError(code: code, status: obj["http"]?.intValue.map(Int.init) ?? status,
                                message: obj["message"]?.stringValue ?? "", body: obj, retryAfter: ra)
        }
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return SubEthaError(code: statusCodes[status] ?? "http_\(status)", status: status, message: String(text.prefix(500)), body: obj ?? [:], retryAfter: ra)
    }
}

/// Misuse of the client (as opposed to an error from the relay).
public enum SubEthaClientError: Error, Equatable, Sendable {
    case missingDeviceSigner
    case missingCrypto
    case missingTopicKey(String)
    case unsupported(String)
    case invalidResponse(String)
}
