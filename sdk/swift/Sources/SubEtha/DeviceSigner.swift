import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// An Ed25519 device key (spec §1.3): signs HTTP requests (`X-Device-*`), enrollment proofs
/// and, with the Rust core, envelopes.
///
/// Implementations: `CryptoKitDeviceSigner` (no native code) and `SubEthaCore.CoreDeviceSigner`.
public protocol DeviceSigner: Sendable {
    /// `dev_` + base32(public key).
    var deviceId: String { get }
    /// Raw 64-byte Ed25519 signature.
    func sign(_ message: Data) throws -> Data
    /// Signs an envelope (spec §4: canonical JSON; sets `sender` and `sig`). Needs the core.
    func signEnvelope(_ envelopeJSON: String) throws -> String
}

extension DeviceSigner {
    public func signEnvelope(_ envelopeJSON: String) throws -> String {
        throw SubEthaClientError.unsupported("envelope signing needs SubEthaCore (CoreDeviceSigner)")
    }
}

/// Signature checks and E2EE (spec §4, §5), provided by `SubEthaCore.CoreEnvelopeCrypto`.
public protocol EnvelopeCrypto: Sendable {
    func verify(_ envelopeJSON: String) -> Bool
    func encrypt(_ envelopeJSON: String, key: Data, kid: String) throws -> String
    /// `nil` if the key is wrong or the message was tampered with.
    func decrypt(_ envelopeJSON: String, key: Data) -> String?
}

#if canImport(CryptoKit)
/// Ed25519 through CryptoKit. Apple's signatures are randomized, so they differ from the
/// core's byte for byte, but verify the same.
public struct CryptoKitDeviceSigner: DeviceSigner {
    private let key: Curve25519.Signing.PrivateKey
    public let deviceId: String
    public var publicKey: Data { key.publicKey.rawRepresentation }
    /// The secret seed, for the Keychain.
    public var seed: Data { key.rawRepresentation }

    public init(seed: Data) throws {
        key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        deviceId = Encoding.deviceId(publicKey: key.publicKey.rawRepresentation)
    }

    public static func generate() -> CryptoKitDeviceSigner {
        // A fresh key's raw representation is always a valid seed.
        try! CryptoKitDeviceSigner(seed: Curve25519.Signing.PrivateKey().rawRepresentation)
    }

    public func sign(_ message: Data) throws -> Data {
        try key.signature(for: message)
    }
}
#endif

/// Device-signed requests and enrollment proofs (see workers/api/src/devices.ts).
public enum RequestSigning {
    /// `URL.host` as WHATWG defines it: lowercase host, plus `:port` unless it is the scheme default.
    static func host(_ comps: URLComponents?) -> String {
        var host = comps?.percentEncodedHost?.lowercased() ?? ""
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" } // IPv6
        let defaultPort: Int? = ["http": 80, "ws": 80, "https": 443, "wss": 443][comps?.scheme?.lowercased() ?? ""]
        if let port = comps?.port, port != defaultPort { return "\(host):\(port)" }
        return host
    }

    /// A fresh single-use nonce: base64url of 16 random bytes.
    public static func newNonce() -> String {
        var rng = SystemRandomNumberGenerator()
        return Encoding.base64url(Data((0..<16).map { _ in UInt8.random(in: 0...255, using: &rng) }))
    }

    /// Headers the SDKs don't sign (spec §8.1): credentials, and headers HTTP stacks set or rewrite.
    public static let unsignedByConvention: Set<String> = [
        "authorization", "host", "content-length", "connection", "transfer-encoding", "user-agent", "accept", "accept-encoding",
    ]

    /// The signing input (spec §8.1, `subetha-req-v2`):
    /// `subetha-req-v2\nMETHOD\nhost\npath?query\nhex(sha256(body))`, then `\nname:value` for each
    /// of `signedHeaders` in order (values trimmed of spaces and tabs).
    public static func input(method: String, url: URL, body: Data, signedHeaders: [(String, String)]) -> String {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = comps?.percentEncodedPath ?? "/"
        if path.isEmpty { path = "/" }
        let query = comps?.percentEncodedQuery.map { "?\($0)" } ?? ""
        var s = "subetha-req-v2\n\(method.uppercased())\n\(host(comps))\n\(path)\(query)\n\(Encoding.hex(Encoding.sha256(body)))"
        let ws = CharacterSet(charactersIn: " \t")
        for (name, value) in signedHeaders {
            s += "\n\(name.lowercased()):\(value.trimmingCharacters(in: ws))"
        }
        return s
    }

    /// The SDK convention for what to sign: X-Device-Id, -Time, -Nonce, then every other header
    /// the request carries, lowercased and sorted, except `unsignedByConvention` and `x-device-*`.
    public static func headersToSign(deviceId: String, time: Int64, nonce: String, headers: [String: String]) -> [(String, String)] {
        var rest: [String: String] = [:]
        for (k, v) in headers {
            let n = k.lowercased()
            if unsignedByConvention.contains(n) || n.hasPrefix("x-device-") { continue }
            rest[n] = v
        }
        let sorted = rest.keys.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
        return [("x-device-id", deviceId), ("x-device-time", String(time)), ("x-device-nonce", nonce)] + sorted.map { ($0, rest[$0]!) }
    }

    /// `X-Device-Id`, `X-Device-Time`, `X-Device-Nonce`, `X-Device-Signed-Headers`,
    /// `X-Device-Signature`. `headers` are the headers the request will carry (content and
    /// routing headers must be signed). Relays accept each nonce once, so sign every request
    /// (and every retry) afresh.
    public static func headers(signer: DeviceSigner, method: String, url: URL, body: Data, time: Int64,
                               nonce: String = RequestSigning.newNonce(), headers: [String: String] = [:]) throws -> [String: String] {
        guard (16...64).contains(nonce.count), nonce.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            throw SubEthaClientError.unsupported("nonce must be 16-64 base64url characters")
        }
        let signed = headersToSign(deviceId: signer.deviceId, time: time, nonce: nonce, headers: headers)
        guard signed.count <= 32 else { throw SubEthaClientError.unsupported("at most 32 signed headers") }
        let sig = try signer.sign(Data(input(method: method, url: url, body: body, signedHeaders: signed).utf8))
        return ["X-Device-Id": signer.deviceId, "X-Device-Time": String(time), "X-Device-Nonce": nonce,
                "X-Device-Signed-Headers": signed.map { $0.0 }.joined(separator: ","),
                "X-Device-Signature": Encoding.base64url(sig)]
    }

    /// Proof of key possession for `POST /v1/device/code`.
    public static func enrollmentProof(signer: DeviceSigner, time: Int64) throws -> (deviceId: String, time: Int64, proof: String) {
        let sig = try signer.sign(Data("subetha-enroll-v1\n\(signer.deviceId)\n\(time)".utf8))
        return (signer.deviceId, time, Encoding.base64url(sig))
    }
}

/// Encodings used by the protocol (spec §1).
public enum Encoding {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")

    /// RFC 4648 base32, lowercase, no padding.
    public static func base32(_ data: Data) -> String {
        var out = ""
        var buffer = 0
        var bits = 0
        for byte in data {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[(buffer >> (bits - 5)) & 31])
                bits -= 5
            }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return out
    }

    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func base64urlDecode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b.append("=") }
        return Data(base64Encoded: b)
    }

    public static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    public static func hexDecode(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        return out
    }

    public static func deviceId(publicKey: Data) -> String { "dev_" + base32(publicKey) }

    public static func sha256(_ data: Data) -> Data {
        #if canImport(CryptoKit)
        return Data(SHA256.hash(data: data))
        #else
        fatalError("SHA-256 needs CryptoKit")
        #endif
    }
}

/// ULIDs (spec §1.1): 48-bit millisecond time + 80 random bits, Crockford base32.
public enum ULID {
    private static let crockford = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    public static func make(date: Date = Date()) -> String {
        var t = UInt64(date.timeIntervalSince1970 * 1000)
        var out = [Character](repeating: "0", count: 26)
        for i in stride(from: 9, through: 0, by: -1) {
            out[i] = crockford[Int(t & 31)]
            t >>= 5
        }
        var rng = SystemRandomNumberGenerator()
        for i in 10..<26 { out[i] = crockford[Int(rng.next() & 31)] }
        return String(out)
    }
}
