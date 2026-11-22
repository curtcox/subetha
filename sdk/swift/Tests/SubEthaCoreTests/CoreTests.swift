import Foundation
import XCTest
import SubEtha
import SubEthaCore

/// Runs against the XCFramework built by scripts/build-xcframework.sh (declared in
/// Package.swift only when it exists).
final class CoreTests: XCTestCase {
    let seed = Encoding.hexDecode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")!
    // Pinned in sdk/core/src/ffi.rs (request_signing test).
    let nonce = "nonce_0123456789abcdef"
    let reqSig = "hXyR-UJPvVOY_8KJZW1IiAn00acCxmcxs6lMO04YnXBqVMuI4N1oMK5blibRcwE2F-Pb941G_8ik9al432kHAA"
    let enrollSig = "ZTDaaJXLPfCowo3I7bl8k3JvIl5nYldqr4735NNFrw4bGcu-Tl2p2W7jYXZH8NuORBcsaVO-5Em3aahKD1eqDQ"

    func vectors(_ name: String) throws -> [String: JSONValue] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../../spec/vectors/\(name)").standardizedFileURL
        return try JSONValue.parse(Data(contentsOf: url)).objectValue!
    }

    func testRequestSignaturesMatchTheCore() throws {
        let s = try CoreDeviceSigner(seed: seed)
        XCTAssertEqual(s.deviceId, "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena")
        let h = try RequestSigning.headers(signer: s, method: "POST", url: URL(string: "https://x.test/v1/ack?x=1")!, body: Data("{}".utf8), time: 1763750000, nonce: nonce)
        XCTAssertEqual(h["X-Device-Signature"], reqSig)
        XCTAssertEqual(h["X-Device-Nonce"], nonce)
        XCTAssertEqual(try RequestSigning.enrollmentProof(signer: s, time: 1763750000).proof, enrollSig)
        let g = CoreDeviceSigner.generate()
        XCTAssertEqual(try CoreDeviceSigner(seed: g.seed).deviceId, g.deviceId)
    }

    func testCanonicalAndTopicVectors() throws {
        let c = try vectors("canonical.json")
        for v in c["valid"]!.arrayValue! {
            XCTAssertEqual(try Core.canonicalize(v["input"]!.jsonString()), v["canonical"]!.stringValue!, v["name"]!.stringValue!)
        }
        for v in c["invalid"]!.arrayValue! {
            XCTAssertThrowsError(try Core.canonicalize(v["input_json"]!.stringValue!), v["name"]!.stringValue!)
        }
        let t = try vectors("topics.json")
        func problems(_ topic: String) -> [String] { Core.validate("{\"topic\":\(JSONValue.string(topic).jsonString())}") }
        for v in t["valid"]!.arrayValue! { XCTAssertTrue(problems(v.stringValue!).isEmpty, v.stringValue!) }
        for v in t["invalid"]!.arrayValue! { XCTAssertFalse(problems(v.stringValue!).isEmpty, v.stringValue!) }
    }

    func testSignatureVectors() throws {
        let v = try vectors("signatures.json")
        let crypto = CoreEnvelopeCrypto()
        for c in v["cases"]!.arrayValue! {
            let s = try CoreDeviceSigner(seed: Encoding.hexDecode(c["seed"]!.stringValue!)!)
            let signed = try JSONValue.parse(s.signEnvelope(c["unsigned"]!.jsonString()))
            XCTAssertEqual(signed["sig"], c["signed"]!["sig"])
            XCTAssertTrue(crypto.verify(c["signed"]!.jsonString()))
        }
        for n in v["negative"]!.arrayValue! {
            XCTAssertFalse(crypto.verify(n["envelope"]!.jsonString()))
        }
        // The relay-set `event` and edge-decremented `hops` are outside the signature.
        for k in ["hops_change", "event_added"] {
            XCTAssertEqual(crypto.verify(v[k]!["envelope"]!.jsonString()), v[k]!["valid"]!.boolValue, k)
        }
    }

    func testE2EEVector() throws {
        let v = try vectors("e2ee.json")
        let key = Encoding.hexDecode(v["key"]!.stringValue!)!
        let crypto = CoreEnvelopeCrypto()
        let dec = try XCTUnwrap(crypto.decrypt(v["encrypted"]!.jsonString(), key: key))
        XCTAssertEqual(try JSONValue.parse(dec), v["plaintext"])
        XCTAssertNil(crypto.decrypt(v["encrypted"]!.jsonString(), key: Data(count: 32)))
    }

    func testClientSignsAndEncrypts() throws {
        let signer = try CoreDeviceSigner(seed: seed)
        let c = SubEtha(deviceSigner: signer, crypto: CoreEnvelopeCrypto(),
                        topicKeys: ["@a/b": TopicKey(kid: "k1", key: Data((0..<32).map { UInt8($0) }))])
        let env = try c.buildEnvelope("@a/b", "secret", PublishOptions(title: "shh"))
        XCTAssertNil(env["title"])
        XCTAssertNotNil(env["enc"])
        XCTAssertEqual(env["sender"], .string(signer.deviceId))
        let text = JSONValue.object(env).jsonString()
        XCTAssertTrue(CoreEnvelopeCrypto().verify(text))
        XCTAssertEqual(Core.validate(text), [])
        let dec = try JSONValue.parse(XCTUnwrap(CoreEnvelopeCrypto().decrypt(text, key: Data((0..<32).map { UInt8($0) }))))
        XCTAssertEqual(dec["message"], "secret")
        XCTAssertEqual(dec["title"], "shh")
    }
}
