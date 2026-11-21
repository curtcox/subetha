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

Package registry releases are pending; install from the repository until then. Build status and
versions are on the [build info page](https://curtcox.github.io/subetha/build-info.html).

## TypeScript

Dependency-free and small enough for web pages.

<!-- include: samples/ts/publish.ts -->

The client also covers polling, subscriptions, dry runs, tokens, topics, traces, and billing
(`poll`, `subscribe`, `estimate`, `createToken`, `configureTopic`, `trace`, `balance`, `checkout`),
plus `request()` for any other route. Useful options:

| Option | Effect |
|---|---|
| `token` | Bearer token. |
| `deviceKey` | Sign every publish ([signed messages](publishing.md#signed-messages)). |
| `signRequests: true` | Authenticate with device signatures instead of a token ([Devices](devices.md)). |
| `topicKeys` | Per-topic E2EE keys: messages to those topics are encrypted, received ones decrypted. |
| `fetch`, `WebSocket` | Bring your own (tests, older runtimes). |

`subscribe()` picks a WebSocket when it can and falls back to an NDJSON stream; pass
`transport: "stream" | "ws" | "poll"` to choose. It acks automatically (`autoAck: false` to
disable) and can drop unsigned or badly signed messages (`verify`, `requireSignature`). Errors
are `SubEthaError` with `code`, `status`, and the JSON `body`.

The protocol layer (`@subetha/sdk/protocol`) has canonical JSON, ULIDs, the topic grammar, device
keys, Ed25519 signatures, XChaCha20-Poly1305 encryption, and the `Deduper`. `subscribeWebPush()`
registers a browser for [Web Push](transports.md#web-push).

## Web components

One script tag gives you a live feed and a send box. Use [publishable tokens](tokens.md#publishable-tokens):
they're visible to anyone who views the page.

<!-- include: samples/web/feed.html -->

`<subetha-feed>` takes `topic` (comma-separated for several), `token`, `since`, `max`, and
`base-url`; its items are styleable with `::part(list)` and `::part(item)`, and it fires a
`message` event. `<subetha-send>` takes `topic`, `token`, `placeholder`, and `label`, and fires
`sent` and `error`.

## CLI

<!-- include: samples/cli/cli.sh -->

`SUBETHA_TOKEN` and `SUBETHA_URL` override the saved login.

## Python

<!-- include: samples/python/publish.py -->

<!-- include: samples/python/subscribe.py -->

<!-- include: samples/python/signed.py -->

`Client.publish` uses ntfy headers for simple messages and switches to JSON for signed messages,
extension fields, or text that can't travel in a header. Errors raise `SubEthaError` with `code`,
`http`, `message`, and `body`.

## Rust core

`subetha-core` implements the protocol (canonical JSON, signatures, E2EE, dedupe), a
store-and-forward outbox, routing and policy intersection, and the edge transports' protocol
logic (audio modem, fountain-coded QR, BLE chunking, gossip). Platform shims supply radios,
speakers, and cameras. Bindings for Swift and Kotlin (UniFFI), Flutter, and React Native are
generated from it; see [`BINDINGS.md`](https://github.com/curtcox/subetha/blob/main/sdk/core/BINDINGS.md).

<!-- include: samples/rust/sign_and_encrypt.rs -->
