// Wrapped topic keys (spec §5.1): a 32-byte E2EE topic key sealed to one device's identity key,
// so an owner can hand keys to enrolled devices through the relay without the relay reading them.
// X25519 (WebCrypto) against the Montgomery form of the device's Ed25519 key, SHA-256 KDF, and
// XChaCha20-Poly1305.

import { canonicalize } from "./canonical.ts";
import { base64urlDecode, base64urlEncode, concatBytes, hexDecode, utf8 } from "./encoding.ts";
import { publicKeyFromDeviceId, type DeviceKey } from "./sign.ts";
import { isTopic } from "./topic.ts";
import { xchachaOpen, xchachaSeal } from "./xchacha.ts";

export const WRAP_ALG = "x25519-xchacha20poly1305";
export const WRAP_DOMAIN = "subetha-wrap-v1\n";
export const KID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface WrappedKey {
  alg: typeof WRAP_ALG;
  topic: string;
  kid: string;
  /** Recipient device id. */
  to: string;
  /** Ephemeral X25519 public key, base64url. */
  epk: string;
  nonce: string;
  ct: string;
}

const P = (1n << 255n) - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint) => pow(a, P - 2n); // inv(0) = 0, as in curve25519-dalek
const D = mod(-121665n * inv(121666n));

const leToBig = (b: Uint8Array) => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
function bigToLe(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/** Montgomery u-coordinate of an Ed25519 public key: u = (1 + y) / (1 − y). Throws if the key isn't a curve point. */
export function ed25519ToX25519Public(pk: Uint8Array): Uint8Array {
  if (pk.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  const y = mod(leToBig(pk) & ((1n << 255n) - 1n));
  // Decompression check: x² = (y² − 1) / (d·y² + 1) must be a square.
  const y2 = (y * y) % P;
  const x2 = mod((y2 - 1n) * inv(mod(D * y2 + 1n)));
  if (x2 !== 0n && pow(x2, (P - 1n) / 2n) !== 1n) throw new Error("not a valid ed25519 public key");
  return bigToLe(mod((1n + y) * inv(mod(1n - y))));
}

const toBuf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const PKCS8_X25519_PREFIX = hexDecode("302e020100300506032b656e04220420");
const PKCS8_ED25519_PREFIX_LEN = 16;

/** The X25519 secret for a device seed: the first 32 bytes of SHA-512(seed) (X25519 clamps it). */
export async function x25519SecretFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  return new Uint8Array(await crypto.subtle.digest("SHA-512", toBuf(seed))).slice(0, 32);
}

async function importSecret(sk: Uint8Array): Promise<{ key: CryptoKey; publicKey: Uint8Array }> {
  const key = await crypto.subtle.importKey("pkcs8", toBuf(concatBytes(PKCS8_X25519_PREFIX, sk)), { name: "X25519" }, true, ["deriveBits"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  return { key, publicKey: base64urlDecode(jwk.x!) };
}

async function x25519(sk: CryptoKey, u: Uint8Array): Promise<Uint8Array> {
  let shared: Uint8Array;
  try {
    const pub = await crypto.subtle.importKey("raw", toBuf(u), { name: "X25519" }, false, []);
    shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub } as unknown as AlgorithmIdentifier, sk, 256));
  } catch {
    throw new Error("x25519 failed (low-order public key)");
  }
  if (shared.every((b) => b === 0)) throw new Error("x25519 failed (low-order public key)");
  return shared;
}

async function wrapKey(shared: Uint8Array, epk: Uint8Array, rpk: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBuf(concatBytes(utf8.encode(WRAP_DOMAIN), shared, epk, rpk))));
}

/** Associated data: the canonical wrapped-key object without `ct`. */
export function wrapAad(w: Omit<WrappedKey, "ct">): Uint8Array {
  return utf8.encode(canonicalize({ alg: w.alg, epk: w.epk, kid: w.kid, nonce: w.nonce, to: w.to, topic: w.topic }));
}

/**
 * Seals `key` (32 bytes) for device `to`. `ephemeralSecret` and `nonce` are for test vectors
 * only; leave them out to use fresh random values.
 */
export async function wrapTopicKey(
  key: Uint8Array,
  meta: { topic: string; kid: string; to: string },
  opts: { ephemeralSecret?: Uint8Array; nonce?: Uint8Array } = {},
): Promise<WrappedKey> {
  if (key.length !== 32) throw new Error("topic key must be 32 bytes");
  if (!isTopic(meta.topic)) throw new Error("invalid topic");
  if (!KID_RE.test(meta.kid)) throw new Error("kid must be 1–64 characters of A–Z a–z 0–9 _ . -");
  const rpk = ed25519ToX25519Public(publicKeyFromDeviceId(meta.to));
  const eph = await importSecret(opts.ephemeralSecret ?? crypto.getRandomValues(new Uint8Array(32)));
  const shared = await x25519(eph.key, rpk);
  const k = await wrapKey(shared, eph.publicKey, rpk);
  const nonce = opts.nonce ?? crypto.getRandomValues(new Uint8Array(24));
  const head = { alg: WRAP_ALG, topic: meta.topic, kid: meta.kid, to: meta.to, epk: base64urlEncode(eph.publicKey), nonce: base64urlEncode(nonce) } as const;
  return { ...head, ct: base64urlEncode(xchachaSeal(k, nonce, key, wrapAad(head))) };
}

/** The seed of a device key: kept on keys made from a seed, else read from the extractable private key. */
async function seedOf(device: DeviceKey | Uint8Array): Promise<Uint8Array> {
  if (device instanceof Uint8Array) return device;
  if (device.seed) return device.seed;
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", device.privateKey)).slice(PKCS8_ED25519_PREFIX_LEN);
}

/**
 * Opens a wrapped key with the recipient's device key (or its 32-byte seed). Returns null if it's
 * malformed, addressed to another device, or was tampered with.
 */
export async function unwrapTopicKey(w: WrappedKey, device: DeviceKey | Uint8Array): Promise<Uint8Array | null> {
  try {
    if (w.alg !== WRAP_ALG || !isTopic(w.topic) || !KID_RE.test(w.kid)) return null;
    const seed = await seedOf(device);
    const me = await importSecret(await x25519SecretFromSeed(seed));
    const rpk = ed25519ToX25519Public(publicKeyFromDeviceId(w.to));
    if (!rpk.every((b, i) => b === me.publicKey[i])) return null; // not for this device
    const epk = base64urlDecode(w.epk);
    const nonce = base64urlDecode(w.nonce);
    if (epk.length !== 32 || nonce.length !== 24) return null;
    const k = await wrapKey(await x25519(me.key, epk), epk, rpk);
    const key = xchachaOpen(k, nonce, base64urlDecode(w.ct), wrapAad(w));
    return key && key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Structural check for wrapped keys arriving from elsewhere (the relay stores them as given). */
export function isWrappedKey(v: unknown): v is WrappedKey {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const w = v as Record<string, unknown>;
  const b64 = (s: unknown, n: number) => typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s) && s.length === n;
  return w.alg === WRAP_ALG && typeof w.topic === "string" && isTopic(w.topic) && typeof w.kid === "string" && KID_RE.test(w.kid)
    && typeof w.to === "string" && /^dev_[a-z2-7]{52}$/.test(w.to) && b64(w.epk, 43) && b64(w.nonce, 32)
    && typeof w.ct === "string" && /^[A-Za-z0-9_-]{64}$/.test(w.ct)
    && Object.keys(w).length === 7;
}
