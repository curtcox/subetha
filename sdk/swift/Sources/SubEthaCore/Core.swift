import Foundation
import SubEtha
import SubEthaCoreFFI

/// A device key backed by the Rust core (UniFFI). Signs requests, enrollment proofs and
/// envelopes; signatures are deterministic and byte-identical across all SubEtha SDKs.
/// Keep `seed` in the Keychain.
public struct CoreDeviceSigner: DeviceSigner {
    public let seed: Data
    public let publicKey: Data
    public let deviceId: String

    public init(seed: Data) throws {
        let record = try SubEthaCoreFFI.deviceKeyFromSeed(seed: seed)
        self.seed = record.seed
        self.publicKey = record.publicKey
        self.deviceId = record.deviceId
    }

    public static func generate() -> CoreDeviceSigner {
        let record = SubEthaCoreFFI.newDeviceKey()
        // A freshly generated record always round-trips.
        return try! CoreDeviceSigner(seed: record.seed)
    }

    public func sign(_ message: Data) throws -> Data {
        try SubEthaCoreFFI.signBytes(seed: seed, message: message)
    }

    public func signEnvelope(_ envelopeJSON: String) throws -> String {
        try SubEthaCoreFFI.signEnvelopeJson(envelopeJson: envelopeJSON, seed: seed)
    }
}

/// Signature checks and E2EE (spec §4, §5) through the Rust core.
public struct CoreEnvelopeCrypto: EnvelopeCrypto {
    public init() {}

    public func verify(_ envelopeJSON: String) -> Bool {
        SubEthaCoreFFI.verifyEnvelopeJson(envelopeJson: envelopeJSON)
    }

    public func encrypt(_ envelopeJSON: String, key: Data, kid: String) throws -> String {
        try SubEthaCoreFFI.encryptEnvelopeJson(envelopeJson: envelopeJSON, key: key, kid: kid)
    }

    public func decrypt(_ envelopeJSON: String, key: Data) -> String? {
        (try? SubEthaCoreFFI.decryptEnvelopeJson(envelopeJson: envelopeJSON, key: key)) ?? nil
    }
}

/// Envelope helpers straight from the core.
public enum Core {
    public static func newMessageId() -> String { SubEthaCoreFFI.newMessageId() }
    public static func canonicalize(_ json: String) throws -> String { try SubEthaCoreFFI.canonicalizeJson(json: json) }
    /// Validation problems (empty = valid).
    public static func validate(_ envelopeJSON: String) -> [String] { SubEthaCoreFFI.validateEnvelopeJson(envelopeJson: envelopeJSON) }
}
