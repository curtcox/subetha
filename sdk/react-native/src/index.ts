// SubEtha for React Native. The TypeScript SDK runs in RN as-is (fetch + WebSocket); this
// package re-exports it and adds RN-friendly defaults:
//
// - RN's fetch has no streaming response bodies, so the JSON-stream transport can't work.
//   `subscribe` here picks WebSocket for one topic and polling for several.
// - Hermes has no WebCrypto Ed25519, so device keys and E2EE come from the Rust core through
//   uniffi-bindgen-react-native (see ./core.ts and README.md).
import { SubEtha, type ClientOptions, type Envelope, type SubscribeOptions, type Subscription } from "@subetha/sdk";

export * from "@subetha/sdk";
export { coreKeyUnwrapper, coreKeyWrapper, coreSigner, coreVerifier, loadCore, urlParts, type SubEthaCore } from "./core.ts";
import { coreSigner, coreVerifier, type SubEthaCore } from "./core.ts";

/** Options for the React Native client: the JS SDK's, plus the Rust core when it's installed. */
export interface RnClientOptions extends ClientOptions {
  /**
   * The Rust core (`loadCore()`). Signatures are checked with it, and with `deviceSeed` publishes
   * and requests are signed with it: Hermes has no WebCrypto Ed25519.
   */
  core?: SubEthaCore | null;
  /** The device's 32-byte Ed25519 seed, used with `core` (see `coreSigner`). */
  deviceSeed?: Uint8Array;
}

/** The transport that works in React Native for these topics. */
export function rnTransport(topics: string | string[], hasWebSocket = typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function"): "ws" | "poll" {
  const n = Array.isArray(topics) ? topics.length : topics.split(",").length;
  return n === 1 && hasWebSocket ? "ws" : "poll";
}

/** A client with RN's global fetch and WebSocket, signing and verifying with the core if given. */
export function createClient(opts: RnClientOptions = {}): SubEtha {
  const g = globalThis as { WebSocket?: typeof WebSocket };
  const { core, deviceSeed, ...rest } = opts;
  if (deviceSeed && !core && !rest.signer) throw new Error("deviceSeed needs the Rust core (loadCore()) or a signer");
  return new SubEtha({
    WebSocket: g.WebSocket,
    ...(core ? { verifyEnvelope: coreVerifier(core) } : {}),
    ...(core && deviceSeed && !rest.deviceKey ? { signer: coreSigner(core, deviceSeed) } : {}),
    ...rest,
  });
}

/**
 * `client.subscribe` with a React Native transport (WebSocket for one topic, else polling)
 * unless `transport` is given. Reconnect, resume, dedupe and acks work as in the JS SDK.
 */
export function subscribe(client: SubEtha, topics: string | string[], onMessage: (m: Envelope) => void | Promise<void>, opts: SubscribeOptions = {}): Subscription {
  return client.subscribe(topics, onMessage, { ...opts, transport: opts.transport ?? rnTransport(topics) });
}
