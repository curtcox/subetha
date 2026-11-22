# Edge transports

Edge transports move messages between nearby devices without the relay: **sound** (speaker →
microphone), **animated QR codes** (screen → camera), **Bluetooth LE**, and LAN. They're free,
work offline and air-gapped, and use the same envelopes as everything else. Sign messages so
receivers can check who sent them, and encrypt them if the content is private: edge relays can
neither forge nor read what they carry.

Try it in the browser with the [Edge lab](/tools/edge.html). Open it on two devices.

| Link | Direction | Speed | Range | Browser support |
|---|---|---|---|---|
| Sound (16-FSK, 2–5 kHz) | one way, broadcast | ~50 bytes/s | a metre or two | all (Web Audio + microphone) |
| Animated QR (fountain coded) | one way | ~1–3 KB/s at 6 fps | line of sight | display: all; scan: browsers with `BarcodeDetector` (Chrome), or pass a decoder such as jsQR |
| Bluetooth LE (GATT + gossip) | both ways | ~1–10 KB/s | ~10 m | Chrome and Edge, central role only (the peer must be a native app or gateway) |
| LAN (UDP multicast + gossip) | both ways | network speed | the local network | none (browsers have no UDP). Node, the CLI, and native apps |

## How it works

Every edge node keeps a **gossip node**: the topics it subscribes to or relays, recent message
ids, and the messages it can still forward. When two nodes meet over a two-way link (BLE, LAN),
they swap summaries, request what they're missing, and deliver it with `hops` reduced by one. A
message published with `hops: 2` can travel two edge hops beyond its first receiver. One-way
links (sound, QR) carry a single `deliver` message, so the receiver runs the same checks:

- no id, wrong topic, `hops` outside 0–16, or expired → dropped
- seen before (on any transport, the relay included) → dropped
- a signature that doesn't verify → dropped (and optionally unsigned → dropped)

The wire formats are specified in [spec §11](https://github.com/curtcox/subetha/blob/main/spec/README.md#11-edge-framings)
and pinned by shared test vectors, so the TypeScript SDK and the Rust core used by the mobile
SDKs interoperate.

## TypeScript

`@subetha/sdk/edge` has the protocol logic and runs anywhere (browser, Node, Workers). The
browser shims (`playAudioFrame`, `listenAudio`, `showAnimatedQr`, `scanAnimatedQr`,
`connectBlePeer`) are in the same module. The script-tag bundle is `https://subetha.org/edge.js`,
which sets `window.SubEthaEdge`.

<!-- include: samples/ts/edge.ts#snippet -->

In a page:

<!-- include: samples/web/edge.html -->

### Browser APIs

| Function | What it does |
|---|---|
| `playAudioFrame(payload, { volume })` | Plays one modem frame. Resolves when playback ends. |
| `listenAudio(onPayload, { windowSeconds })` | Microphone → frames (echo cancellation and noise suppression off). Returns `{ stop() }`. `windowSeconds` must cover the longest frame you expect: 50 bytes per second, plus 0.6 s. |
| `showAnimatedQr(canvas, payload, { version, ecl, fps })` | Draws an endless frame stream. Version 10–15 with level L scans well on phones. |
| `scanAnimatedQr(video, onPayload, { detect, onProgress })` | Camera → frames → payload. `detect` is any `(video) => Promise<string[]>`. |
| `connectBlePeer(node, onMessage)` | Web Bluetooth central: connects to a peer advertising the SubEtha service and gossips. Must be called from a click. |

Without the browser shims, `AudioFrameReceiver`, `QrFrameReceiver`, and `BleLink` take raw
samples, scanned strings, or GATT chunks. Native shims (and tests) drive them the same way.

## LAN

Devices on the same network find each other with UDP multicast beacons and gossip directly,
with no internet connection needed. From the CLI:

```bash
subetha lan @me/doorbell                         # print messages from peers on this network
subetha lan @me/doorbell --send "Door opened" --hops 2 --for 10
```

In Node, `startLan(node, onMessage)` from `@subetha/sdk/edge/lan-node` joins the LAN and
returns `{ resync(), peers(), stop() }`. Call `resync()` after publishing so peers hear about the
new message right away. `LanGossip` is the socket-free core, for other runtimes.

## Mobile and Rust

The Rust core (`subetha_core::edge`) has the same modem, fountain codec, BLE chunking, and gossip
node. The Swift, Kotlin, Flutter, and React Native SDKs reach it through the core bindings, and
the platform supplies the radio, speaker, microphone, or camera.

The Kotlin (`org.subetha:subetha-core`), Swift (`SubEthaCore`), and Flutter (`subetha_core`) SDKs add drivers that do
everything except move bytes, the same as the TypeScript ones:

| Driver | Feed it | It gives you |
|---|---|---|
| `AudioLink` | microphone samples at the device's rate | decoded payloads; samples to play for yours |
| `QrSender` / `QrReceiver` | scanned QR strings | base45 text for each animated frame; completed payloads |
| `BleLink` | each notification or write from a peer, and the negotiated ATT MTU | chunks to write or notify |
| `GossipSession` | gossip messages over any two-way link | replies and new envelopes |
| `EdgeBridge` | a `SubEtha` client and a gossip node | relay messages in the node; `uplink` for edge messages |

The sample apps wire them to the platform APIs, and are the place to copy from:

- **Android** ([`samples/android`](https://github.com/curtcox/subetha/tree/main/samples/android)):
  `AndroidBle.kt` (BluetoothGattServer and advertising as a peripheral, scanning and GATT client
  connections as a central, one queued GATT operation at a time), `AndroidAudio.kt`
  (AudioTrack/AudioRecord), and `QrViews.kt` (ZXing on CameraX frames).
- **iOS** ([`samples/ios`](https://github.com/curtcox/subetha/tree/main/samples/ios)):
  `AppleBle.swift` (CBPeripheralManager and CBCentralManager), `AppleAudio.swift`
  (AVAudioEngine in measurement mode), and `QrViews.swift` (CoreImage and
  AVCaptureMetadataOutput).
- **Flutter** ([`samples/flutter`](https://github.com/curtcox/subetha/tree/main/samples/flutter)):
  `lib/edge.dart` with `record`/`audioplayers`, `qr_flutter`/`mobile_scanner`, and
  `flutter_reactive_ble` as a BLE central (it connects to the native samples).

A phone running either sample is a BLE **peripheral** as well as a central, advertising the
service in [spec §11.3](https://github.com/curtcox/subetha/blob/main/spec/README.md#113-bluetooth-le), so
browsers (which can only be centrals) connect to it. Phones that see each other connect and
gossip. Each envelope's `hops` limits how many phones it passes through. iOS only does BLE in the
foreground for this, and can't put data in its advertisements, so two phones may end up with two
connections between them. That's harmless because gossip drops duplicates.

## Bridging to the relay

A device with internet access can act as a gateway for nearby offline devices. `bridgeEdge`
subscribes to the relay and feeds new messages into the gateway's gossip node, giving them
`hops` if they have none, so edge peers pick them up. In the other direction, messages that
arrive over edge links are published to the relay unchanged (`client.publishEnvelope`). The
signature still verifies because `hops` isn't signed, and the relay drops a message it has
already seen by id. Uplinked publishes are billed to the gateway's token like any other.

<!-- include: samples/ts/edge-bridge.ts#snippet -->

On phones, the samples' **Bridge to relay** button does the same with `EdgeBridge`. The
[offline BLE-hop demo](https://github.com/curtcox/subetha/tree/main/samples/android#offline-ble-hop-demo)
uses one online phone as the gateway for an offline one.
