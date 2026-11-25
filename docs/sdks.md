# SDKs & CLI

You never *need* an SDK (the API is plain HTTP), but the SDKs handle the fiddly parts:
reconnecting with `since=`, dedupe across transports, acks, signatures, end-to-end encryption,
and typed errors. All of them pass the same
[conformance vectors](https://github.com/curtcox/subetha/tree/main/spec/vectors), so a message
signed or encrypted by one verifies and decrypts in all the others.

| SDK | Package | Runs on | Source |
|---|---|---|---|
| TypeScript (+ CLI, web components) | `@subetha/sdk` | browsers, Node 18+, Deno, Bun, Workers | [`sdk/js`](https://github.com/curtcox/subetha/tree/main/sdk/js) |
| Python | `subetha` | Python 3.11+ | [`sdk/python`](https://github.com/curtcox/subetha/tree/main/sdk/python) |
| Rust core | `subetha-core` | anywhere; the base for Swift, Kotlin, Flutter, and React Native bindings | [`sdk/core`](https://github.com/curtcox/subetha/tree/main/sdk/core) |
| Swift | `SubEtha` (+ `SubEthaCore`) | iOS, macOS | [`sdk/swift`](https://github.com/curtcox/subetha/tree/main/sdk/swift) |
| Kotlin | `us.subetha:subetha` (+ `subetha-core`) | Android, JVM | [`sdk/kotlin`](https://github.com/curtcox/subetha/tree/main/sdk/kotlin) |
| Dart / Flutter | `subetha` (+ the `subetha_core` plugin) | Flutter on Android and iOS; Dart VM | [`sdk/flutter`](https://github.com/curtcox/subetha/tree/main/sdk/flutter), [`sdk/flutter_core`](https://github.com/curtcox/subetha/tree/main/sdk/flutter_core) |
| React Native | `@subetha/react-native` (+ `@subetha/react-native-core`) | React Native and Expo (Hermes) | [`sdk/react-native`](https://github.com/curtcox/subetha/tree/main/sdk/react-native), [`sdk/react-native-core`](https://github.com/curtcox/subetha/tree/main/sdk/react-native-core) |

The packages in parentheses carry the Rust core for that platform: device keys, signatures, E2EE,
and the edge transports. The mobile SDKs work without them for relay messaging.

Package registry releases are pending; install from the repository until then. Build status and
versions are on the [build info page](https://curtcox.github.io/subetha/build-info.html).

## TypeScript

Dependency-free and small enough for web pages.

<!-- include: samples/ts/publish.ts -->

The client also covers attachments, polling, subscriptions, dry runs, tokens, topics, traces, and billing
(`publishFile`, `estimateFile`, `poll`, `subscribe`, `estimate`, `createToken`, `configureTopic`, `trace`, `balance`, `checkout`),
plus `request()` for any other route. Useful options:

| Option | Effect |
|---|---|
| `token` | Bearer token (or a `() => Promise<string \| null>` provider for rotating JWTs). |
| `deviceKey` | Sign every publish ([signed messages](publishing.md#signed-messages)). |
| `signer`, `verifyEnvelope` | Sign and check signatures with something other than WebCrypto Ed25519, e.g. the Rust core in React Native (`createClient({ core, deviceSeed })` in `@subetha/react-native`). |
| `dba` | Authenticate as a devicebasedauth.org device: anything with `headers(method, url)`, such as `new DBA()` from devicebasedauth.org's browser SDK ([Devices](devices.md)). `attachDeviceKey(key)` then attaches a signing key. |
| `signRequests: true` | Authenticate with device signatures (an attached key) instead of a token ([Devices](devices.md#signed-requests)). |
| `topicKeys` | Per-topic E2EE keys: messages to those topics are encrypted, received ones decrypted. `loadTopicKeys()` adds the ones [shared with this device](publishing.md#sharing-keys-with-devices) (in React Native, pass `unwrapper: coreKeyUnwrapper(core, seed)` and `wrapper: coreKeyWrapper(core)`; in Swift and Kotlin, `CoreDeviceSigner.unwrapTopicKey` and `CoreKeyWrap.wrap`). |
| `fetch`, `WebSocket` | Bring your own (tests, older runtimes). |

`subscribe()` picks a WebSocket when it can and falls back to an NDJSON stream; pass
`transport: "stream" | "ws" | "poll"` to choose. It acks automatically (`autoAck: false` to
disable) and can drop unsigned or badly signed messages (`verify`, `requireSignature`). Errors
are `SubEthaError` with `code`, `status`, and the JSON `body`.

The protocol layer (`@subetha/sdk/protocol`) has canonical JSON, ULIDs, the topic grammar, device
keys, Ed25519 signatures, XChaCha20-Poly1305 encryption, wrapped topic keys (`wrapTopicKey`,
`unwrapTopicKey`), and the `Deduper`. `subscribeWebPush()`
registers a browser for [Web Push](transports.md#web-push).

## Web components

One script tag gives you a live feed and a send box. Use [publishable tokens](tokens.md#publishable-tokens):
they're visible to anyone who views the page.

<!-- include: samples/web/feed.html -->

`<subetha-feed>` takes `topic` (comma-separated for several), `token`, `since`, `max`, `priority`, `tags`, and
`base-url`; its items are styleable with `::part(list)` and `::part(item)`, and it fires a
`message` event. `<subetha-send>` takes `topic`, `token`, `placeholder`, `label`, `title`, `priority`, and `tags`, and fires
`sent` and `error`.

## CLI

<!-- include: samples/cli/cli.sh -->

`SUBETHA_TOKEN` and `SUBETHA_URL` override the saved login. Running `subetha login` with no token attaches a fresh signing key through this machine's devicebasedauth.org device (enroll it first with `dba enroll --aud subetha.us --action subetha:publish --action subetha:subscribe`) and saves it, so the CLI signs requests without storing a bearer token. `subetha pub --file PATH` uploads an attachment, and `subetha trace` / `subetha ack` inspect or acknowledge messages.

## Python

<!-- include: samples/python/publish.py -->

<!-- include: samples/python/subscribe.py -->

<!-- include: samples/python/signed.py -->

`Client(dba=…)` authenticates as a devicebasedauth.org device and `attach_device_key()` attaches
a signing key ([Devices](devices.md)). `Client.publish` uses ntfy headers for simple messages and switches to JSON for signed messages,
extension fields, or text that can't travel in a header. Errors raise `SubEthaError` with `code`,
`http`, `message`, and `body`.

## Rust core

`subetha-core` implements the protocol (canonical JSON, signatures, E2EE, dedupe), a
store-and-forward outbox, routing and policy intersection, and the edge transports' protocol
logic (audio modem, fountain-coded QR, BLE chunking, gossip). Platform shims supply radios,
speakers, and cameras. Bindings for Swift and Kotlin (UniFFI), Flutter, and React Native are
generated from it; see [`BINDINGS.md`](https://github.com/curtcox/subetha/blob/main/sdk/core/BINDINGS.md).

<!-- include: samples/rust/sign_and_encrypt.rs -->

## Mobile SDKs (Swift, Kotlin, Flutter, React Native)

All four mobile SDKs share the same API shape (`publish`, `publishFile`, `estimate`, `poll`, `subscribe`, `ack`, `setTopicKey`, wrapped topic keys, control-plane helpers, and devicebasedauth.org devices through a `dba` header provider with `attachDeviceKey`) and optionally link `subetha-core` for Ed25519 signing, E2EE, store-and-forward outbox, and edge transports (BLE, audio, animated QR, LAN):

- **Swift (`sdk/swift`)**: `SubEtha(token: ...)` + `SubEthaCore` (UniFFI). See [`sdk/swift/README.md`](https://github.com/curtcox/subetha/blob/main/sdk/swift/README.md) and [`samples/ios`](https://github.com/curtcox/subetha/tree/main/samples/ios).
- **Kotlin / Android (`sdk/kotlin`)**: `SubEtha(token = ...)` + `subetha-core` (UniFFI). See [`sdk/kotlin/README.md`](https://github.com/curtcox/subetha/blob/main/sdk/kotlin/README.md) and [`samples/android`](https://github.com/curtcox/subetha/tree/main/samples/android).
- **Dart / Flutter (`sdk/flutter`, `sdk/flutter_core`)**: `SubEtha(token: ...)` + `subetha_core` (`flutter_rust_bridge`). See [`sdk/flutter/README.md`](https://github.com/curtcox/subetha/blob/main/sdk/flutter/README.md) and [`samples/flutter`](https://github.com/curtcox/subetha/tree/main/samples/flutter).
- **React Native / Expo (`sdk/react-native`, `sdk/react-native-core`)**: `createClient({ core, deviceSeed, token })` (`uniffi-bindgen-react-native` Turbo Module) with `coreSigner`, `coreVerifier`, `coreKeyWrapper`, and `coreKeyUnwrapper`. See [`sdk/react-native/README.md`](https://github.com/curtcox/subetha/blob/main/sdk/react-native/README.md) and [`samples/react-native`](https://github.com/curtcox/subetha/tree/main/samples/react-native).
