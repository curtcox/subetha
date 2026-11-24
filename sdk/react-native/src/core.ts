// Seam for the Rust core (sdk/core) in React Native. `@subetha/react-native-core`
// (sdk/react-native-core) is the Turbo Module (JSI/C++) plus TypeScript that
// uniffi-bindgen-react-native generates from the same UniFFI surface as the Swift/Kotlin
// bindings. This package doesn't depend on it: without it, `loadCore()` returns null and apps
// use the pure-TS SDK.
//
// Metro only bundles modules named by a literal require/import, so the app names the package:
//   const core = await loadCore(() => require("@subetha/react-native-core"));

/**
 * The part of the generated module this package uses (camelCase names of sdk/core/src/ffi.rs).
 * The module exports more (edge objects, the outbox, the deduper); import it directly for those.
 */
export interface SubEthaCore {
  newDeviceKey(): { seed: ArrayBuffer; publicKey: ArrayBuffer; deviceId: string };
  deviceKeyFromSeed(seed: ArrayBuffer): { seed: ArrayBuffer; publicKey: ArrayBuffer; deviceId: string };
  newMessageId(): string;
  canonicalizeJson(json: string): string;
  validateEnvelopeJson(envelopeJson: string): string[];
  signEnvelopeJson(envelopeJson: string, seed: ArrayBuffer): string;
  verifyEnvelopeJson(envelopeJson: string): boolean;
  encryptEnvelopeJson(envelopeJson: string, key: ArrayBuffer, kid: string): string;
  decryptEnvelopeJson(envelopeJson: string, key: ArrayBuffer): string | undefined;
  signBytes(seed: ArrayBuffer, message: ArrayBuffer): ArrayBuffer;
  newRequestNonce(): string;
  /** subetha-req-v2 (spec §8.1): `signedHeaders` in the order they are listed. */
  requestSigningInput(method: string, host: string, pathAndQuery: string, body: ArrayBuffer, signedHeaders: { name: string; value: string }[]): string;
  signRequest(seed: ArrayBuffer, method: string, host: string, pathAndQuery: string, time: bigint, nonce: string | undefined, body: ArrayBuffer, headers: { name: string; value: string }[]): { deviceId: string; time: bigint; nonce: string; signedHeaders: string; signature: string };
  enrollmentProof(seed: ArrayBuffer, time: bigint): { deviceId: string; time: bigint; proof: string };
  /** Wrapped topic keys (spec §5.1). */
  wrapTopicKeyJson(key: ArrayBuffer, topic: string, kid: string, to: string): string;
  unwrapTopicKeyJson(wrappedJson: string, seed: ArrayBuffer): ArrayBuffer | undefined;
}

import type { DeviceSigner, Envelope, KeyUnwrapper, KeyWrapper, WrappedKey } from "@subetha/sdk";

/** The name the ubrn-generated package is published under. */
export const CORE_PACKAGE = "@subetha/react-native-core";

/**
 * The native core from `load` (which should require or import CORE_PACKAGE), or null if it is
 * missing, fails to load, or doesn't look like the core. Without `load`, null: Metro rejects
 * requires of computed names, so this package can't look the module up itself.
 */
export async function loadCore(load?: (name: string) => unknown): Promise<SubEthaCore | null> {
  if (!load) return null;
  try {
    // ubrn's index exports the functions by name and, as the default export, one namespace per
    // crate ({ subetha_core }); accept either, or a module whose default is the core itself.
    const mod = (await load(CORE_PACKAGE)) as Record<string, unknown> | null | undefined;
    const dflt = mod?.default as Record<string, unknown> | undefined;
    const found = [mod, dflt, dflt?.subetha_core, mod?.subetha_core].find(looksLikeCore);
    return (found as SubEthaCore | undefined) ?? null;
  } catch {
    return null;
  }
}

function looksLikeCore(m: unknown): boolean {
  const c = m as Partial<SubEthaCore> | null | undefined;
  return typeof c?.signEnvelopeJson === "function" && typeof c?.verifyEnvelopeJson === "function";
}

const toArrayBuffer = (b: Uint8Array | ArrayBuffer): ArrayBuffer => (b instanceof ArrayBuffer ? b : (b.slice().buffer as ArrayBuffer));

/**
 * `host` (WHATWG `URL.host`: lowercase, port only when not the scheme's default) and
 * `path?query` of an absolute URL. Parsed by hand: React Native's `URL` doesn't implement `host`.
 */
export function urlParts(url: string): { host: string; pathAndQuery: string } {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/i.exec(url);
  if (!m) throw new Error(`not an absolute URL: ${url}`);
  const scheme = m[1]!.toLowerCase();
  let host = m[2]!.replace(/^.*@/, "").toLowerCase();
  const defaultPort = { http: "80", ws: "80", https: "443", wss: "443" }[scheme];
  if (defaultPort && host.endsWith(`:${defaultPort}`)) host = host.slice(0, -defaultPort.length - 1);
  const rest = m[3]!;
  return { host, pathAndQuery: rest.startsWith("/") ? rest : `/${rest}` };
}

/**
 * A DeviceSigner (for `createClient({ signer })`) that signs envelopes and requests with the
 * Rust core, from the device's 32-byte seed (keep it in the platform keystore).
 */
export function coreSigner(core: SubEthaCore, seed: Uint8Array | ArrayBuffer): DeviceSigner {
  const seedBuf = toArrayBuffer(seed);
  const { deviceId } = core.deviceKeyFromSeed(seedBuf);
  return {
    deviceId,
    signEnvelope: (env) => JSON.parse(core.signEnvelopeJson(JSON.stringify(env), seedBuf)) as Envelope,
    signRequest: (method, url, body, headers, nowSec) => {
      const { host, pathAndQuery } = urlParts(url);
      const list = [...headers].map(([name, value]) => ({ name, value }));
      const r = core.signRequest(seedBuf, method.toUpperCase(), host, pathAndQuery, BigInt(nowSec), undefined, toArrayBuffer(body), list);
      return {
        "x-device-id": r.deviceId,
        "x-device-time": String(r.time),
        "x-device-nonce": r.nonce,
        "x-device-signed-headers": r.signedHeaders,
        "x-device-signature": r.signature,
      };
    },
  };
}

/** An envelope signature check (for `createClient({ verifyEnvelope })`) by the Rust core. */
export function coreVerifier(core: SubEthaCore): (env: Envelope) => boolean {
  return (env) => core.verifyEnvelopeJson(JSON.stringify(env));
}

/**
 * Opens wrapped topic keys with the Rust core, for `client.loadTopicKeys({ unwrapper })`
 * (Hermes has no WebCrypto X25519).
 */
export function coreKeyUnwrapper(core: SubEthaCore, seed: Uint8Array | ArrayBuffer): KeyUnwrapper {
  const seedBuf = toArrayBuffer(seed);
  const { deviceId } = core.deviceKeyFromSeed(seedBuf);
  return {
    deviceId,
    unwrap: (w) => {
      try {
        const k = core.unwrapTopicKeyJson(JSON.stringify(w), seedBuf);
        return k ? new Uint8Array(k) : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Wraps topic keys for recipient devices with the Rust core, for `client.shareTopicKey(..., { wrapper })`
 * (Hermes has no WebCrypto X25519).
 */
export function coreKeyWrapper(core: SubEthaCore): KeyWrapper {
  return {
    wrap: (key, meta) => JSON.parse(core.wrapTopicKeyJson(toArrayBuffer(key), meta.topic, meta.kid, meta.to)) as WrappedKey,
  };
}
