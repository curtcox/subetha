// Seam for the Rust core (sdk/core) in React Native. uniffi-bindgen-react-native (ubrn)
// generates a Turbo Module (JSI/C++) plus TypeScript from the same UniFFI surface as the
// Swift/Kotlin bindings; see ../ubrn.config.yaml and README.md. Until that package is built and
// installed, `loadCore()` returns null and apps use the pure-TS SDK.
//
// Metro only bundles modules named by a literal require/import, so the app names the package:
//   const core = await loadCore(() => require("@subetha/react-native-core"));

/** The generated module's surface (camelCase names of sdk/core/src/ffi.rs). */
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
}

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
    const mod = (await load(CORE_PACKAGE)) as { default?: SubEthaCore } & Partial<SubEthaCore>;
    const core = (mod.default ?? mod) as Partial<SubEthaCore>;
    return typeof core.signEnvelopeJson === "function" && typeof core.verifyEnvelopeJson === "function" ? (core as SubEthaCore) : null;
  } catch {
    return null;
  }
}
