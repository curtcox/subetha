# SubEtha for Swift (iOS 15+, macOS 12+)

```swift
.package(url: "https://github.com/curtcox/subetha", from: "0.1.0") // path: sdk/swift
```

| Product | What | Native code |
|---|---|---|
| `SubEtha` | async/await client: publish, dry-run estimates, poll, subscribe (`AsyncThrowingStream` or handler) with reconnect from the last id, dedupe and acks; devicebasedauth.org devices (`dba:`), attached signing keys and device-signed requests; `SubEthaError` | none (URLSession, CryptoKit) |
| `SubEthaCore` | Rust core through UniFFI: `CoreDeviceSigner` (requests + envelope signatures), `CoreEnvelopeCrypto` (verify, E2EE), canonical JSON, validation | `subetha_coreFFI.xcframework` |

```swift
import SubEtha

let client = SubEtha(token: token)
try await client.publish("@me/doorbell", "ding", PublishOptions(title: "Front door", priority: 4))

let est = try await client.estimate("@me/doorbell", "ding", PublishOptions(route: Route(mode: .all, maxCostUSD: 0.05)))
print("worst case $\(est.estimateUSD)", est.plan)

for try await m in client.messages(["@me/doorbell"], options: SubscribeOptions(since: "10m")) {
    print(m.title ?? "", m.message ?? "")
}
```

`subscribe(_:options:handler:)` acks each message after the handler returns. `messages(_:)` acks
once a message is yielded. Both reconnect with exponential backoff (or `Retry-After`) and resume
with `since=<last id>`. 4xx errors other than 408/429 are thrown. Cancelling the task (or leaving
the `for try await` loop) closes the connection.

### Device keys

Devices enroll at [devicebasedauth.org](https://devicebasedauth.org) for the audience
`subetha.us` (its iOS SDK keeps the key in the Secure Enclave). Pass anything conforming to
`DBAHeaders` (the `Authorization: DBA …` and `DPoP` headers for each request) as `dba:`:

```swift
let client = SubEtha(dba: myDBADevice)                // publishes and subscribes within its grants
let signer = CryptoKitDeviceSigner.generate()       // or SubEthaCore.CoreDeviceSigner.generate()
try await SubEtha(deviceSigner: signer, dba: myDBADevice).attachDeviceKey(name: UIDevice.current.name)
let device = SubEtha(deviceSigner: signer, signRequests: true) // X-Device-* headers, no token
```

Store `signer.seed` in the Keychain. CryptoKit's Ed25519 signatures are randomized (still valid).
`CoreDeviceSigner` is deterministic and also signs envelopes. E2EE needs
`crypto: CoreEnvelopeCrypto()` plus `topicKeys`.

### Edge transports

`SubEthaCore` has drivers for the edge transports (spec §11). Your CoreBluetooth or
AVAudioEngine code moves bytes and samples; the drivers do the protocol:

```swift
let node = EdgeGossipNode(requireSignatures: true)
node.subscribe(topic: "@me/doorbell")

// BLE: one link per connection, central or peripheral.
let link = BleLink(node: node, write: { peripheral.writeValue($0, for: inbox, type: .withoutResponse) },
                   onMessage: { show($0) }, attMtu: peripheral.maximumWriteValueLength(for: .withoutResponse) + 3)
link.resync()                    // on connect and after publishing
// peripheral(_:didUpdateValueFor:error:) -> link.receive(characteristic.value!)

// Sound: play through AVAudioPlayerNode, feed input-tap buffers back in.
let audio = AudioLink(sampleRate: 48_000, play: { schedule($0) }, onPayload: { Edge.acceptPayload(node, $0).forEach(show) })
try audio.send(Edge.deliverPayload([envelopeJSON]))

// Gateway: relay messages go out over edge links, edge messages go up to the relay.
let bridge = EdgeBridge(client: client, node: node, topics: ["@me/doorbell"], onDownlink: { _ in DispatchQueue.main.async { link.resync() } })
// in onMessage: Task { await bridge.uplink(env) }
```

Drive each link from one queue. `GossipSession` is the transport-neutral core of `BleLink`.

`LanGossip` is LAN discovery and gossip (spec §11.5) without sockets, and is thread-safe: feed
it datagrams from your multicast socket (`onBeacon`, group `Edge.lanGroup`, port `Edge.lanPort`)
and your unicast socket (`onDatagram`), multicast `beacon()` every few seconds, and send what it
hands to `send`. On iOS, receiving multicast needs Apple's
`com.apple.developer.networking.multicast` entitlement, which Apple grants on request.

## The core XCFramework

```bash
sdk/core/scripts/gen-bindings.sh            # regenerates Sources/SubEthaCoreFFI + ffi/ (committed)
sdk/swift/scripts/build-xcframework.sh      # iOS device + simulator + macOS → build/subetha_coreFFI.xcframework
sdk/swift/scripts/build-xcframework.sh --macos-only   # host slice only, for `swift test`
cd sdk/swift && swift test                  # SubEthaTests always; SubEthaCoreTests once the XCFramework exists
```

`Package.swift` declares `SubEthaCore` only when `build/subetha_coreFFI.xcframework` exists, or
when `SUBETHA_CORE_XCFRAMEWORK_URL` and `SUBETHA_CORE_XCFRAMEWORK_CHECKSUM` name a released zip
(`build-xcframework.sh --zip` prints the checksum). So the pure client always resolves, and
nothing in the repo is a binary.

The UniFFI Swift (`Sources/SubEthaCoreFFI/subetha_core.swift`) and its C header/modulemap
(`ffi/`) are generated and committed. CI checks they match the Rust code.

`samples/ios` is a SwiftUI app that uses this package.
