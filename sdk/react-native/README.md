# @subetha/react-native

The TypeScript SDK (`@subetha/sdk`) already runs in React Native. It is dependency-free and
uses `fetch` and `WebSocket`. This package re-exports it and adds RN defaults:

```ts
import { createClient, subscribe } from "@subetha/react-native";

const client = createClient({ token });                 // global fetch + WebSocket
await client.publish("@me/doorbell", "ding", { title: "Front door" });
const est = await client.estimate("@me/doorbell", "ding", { route: { mode: "all" } });

const sub = subscribe(client, "@me/doorbell", (m) => console.log(m.message)); // WebSocket
sub.close();
```

- **Transports.** RN's `fetch` can't stream response bodies, so the JSON-stream transport can't
  work there. `subscribe()` picks WebSocket for a single topic and polling for several
  (`rnTransport`). Pass `transport` to override.
- **Device keys / E2EE.** The JS SDK signs with WebCrypto Ed25519 and encrypts with its own
  XChaCha20. Hermes has no `crypto.subtle`, so use the Rust core there (below), or a
  WebCrypto polyfill.

## Rust core via uniffi-bindgen-react-native (scaffold)

`src/core.ts` declares the `SubEthaCore` surface (the camelCase names of
`sdk/core/src/ffi.rs`). `loadCore()` returns the native module once the app has installed
`@subetha/react-native-core`, and `null` until then. `ubrn.config.yaml` is the starting config
for [uniffi-bindgen-react-native](https://jhugman.github.io/uniffi-bindgen-react-native/):

```bash
cd sdk/react-native
npx uniffi-bindgen-react-native build android --config ubrn.config.yaml --and-generate
npx uniffi-bindgen-react-native build ios     --config ubrn.config.yaml --and-generate
```

That generates a Turbo Module (JSI/C++) and TypeScript bindings over the same UniFFI surface
as Swift/Kotlin (uniffi 0.28). Edge features (BLE gossip, the audio modem, animated QR) then
follow the same path: stateful core objects exported as UniFFI objects, driven by RN modules
for BLE (`react-native-ble-plx`), the camera and audio. This isn't built in CI yet; see
`sdk/core/BINDINGS.md`. Check the config keys against the ubrn version you install.

## Tests

`pnpm --filter @subetha/react-native test` runs in Node with a fake WebSocket and a mock fetch:
re-exports, transport choice, publish, WebSocket subscribe with dedupe and socket acks, and
`loadCore`.

`samples/react-native` is an Expo app that uses this package.
