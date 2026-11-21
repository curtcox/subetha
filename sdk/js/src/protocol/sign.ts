// Device identity and signatures (spec §1.3, §4). Uses WebCrypto Ed25519.

import { canonicalEnvelope } from "./canonical.ts";
import { base32Decode, base32Encode, base64urlDecode, base64urlEncode, concatBytes, hexDecode, utf8 } from "./encoding.ts";

export const SIG_DOMAIN = "subetha-sig-v1\n";
export const DEVICE_ID_RE = /^dev_[a-z2-7]{52}$/;
const PKCS8_ED25519_PREFIX = hexDecode("302e020100300506032b657004220420");

export interface DeviceKey {
  deviceId: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  /** 32-byte seed, kept only when the key was created or imported from a seed. */
  seed?: Uint8Array;
}

const toBuf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export function deviceIdFromPublicKey(pk: Uint8Array): string {
  if (pk.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return "dev_" + base32Encode(pk);
}

export function publicKeyFromDeviceId(id: string): Uint8Array {
  if (!DEVICE_ID_RE.test(id)) throw new Error("invalid device id");
  const pk = base32Decode(id.slice(4));
  // The last base32 character carries 4 unused bits; only the canonical encoding is valid,
  // so each key has exactly one id (allow/deny lists compare id strings).
  if (pk.length !== 32 || base32Encode(pk) !== id.slice(4)) throw new Error("non-canonical device id");
  return pk;
}

export async function deviceKeyFromSeed(seed: Uint8Array): Promise<DeviceKey> {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    toBuf(concatBytes(PKCS8_ED25519_PREFIX, seed)),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const publicKey = base64urlDecode(jwk.x!);
  return { deviceId: deviceIdFromPublicKey(publicKey), publicKey, privateKey, seed };
}

export async function generateDeviceKey(): Promise<DeviceKey> {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return deviceKeyFromSeed(seed);
}

function signingBytes(env: Record<string, unknown>): Uint8Array {
  return utf8.encode(SIG_DOMAIN + canonicalEnvelope(env));
}

/** Returns a copy of the envelope with `sender` and `sig` set. */
export async function signEnvelope<T extends Record<string, unknown>>(env: T, key: DeviceKey): Promise<T & { sender: string; sig: string }> {
  if (typeof env.id !== "string" || typeof env.time !== "number") {
    throw new Error("signed messages must carry id and time");
  }
  const { sig: _old, ...rest } = env;
  const unsigned = { ...rest, sender: key.deviceId } as Record<string, unknown>;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, toBuf(signingBytes(unsigned))));
  return { ...unsigned, sig: "ed25519:" + base64urlEncode(sig) } as T & { sender: string; sig: string };
}

/** Verifies `sig` against the public key embedded in `sender`. Never throws. */
export async function verifyEnvelope(env: Record<string, unknown>): Promise<boolean> {
  try {
    const { sig, sender } = env;
    if (typeof sig !== "string" || !sig.startsWith("ed25519:") || typeof sender !== "string") return false;
    const pk = publicKeyFromDeviceId(sender);
    const sigBytes = base64urlDecode(sig.slice(8));
    if (sigBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", toBuf(pk), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, toBuf(sigBytes), toBuf(signingBytes(env)));
  } catch {
    return false;
  }
}
