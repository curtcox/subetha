// Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm per RFC 8188) and VAPID
// (RFC 8292), using only WebCrypto. The endpoint address is the browser's PushSubscription JSON:
// {"endpoint": "https://…", "keys": {"p256dh": "<base64url 65-byte point>", "auth": "<base64url 16 bytes>"}}.
import { base64urlDecode, base64urlEncode, concatBytes, utf8, type Envelope } from "@subetha/sdk/protocol";
import type { Env } from "../types.ts";
import { signJwt, trimEnvelope, unverifyEndpoint } from "./push.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender } from "./senders.ts";

export const WEBPUSH_MAX_PAYLOAD = 3800; // push services accept 4096-byte bodies; leave room for header + tag
const RECORD_SIZE = 4096;

export interface PushSubscriptionJSON { endpoint: string; keys: { p256dh: string; auth: string } }

const bs = (b: Uint8Array) => b as BufferSource;

function pointToJwk(pub: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (pub.length !== 65 || pub[0] !== 4) throw new PermanentError("expected an uncompressed P-256 public key (65 bytes)");
  return { kty: "EC", crv: "P-256", x: base64urlEncode(pub.slice(1, 33)), y: base64urlEncode(pub.slice(33, 65)), ...(d ? { d: base64urlEncode(d) } : {}), ext: true };
}

/** Import a raw 32-byte private scalar (with its 65-byte public point) for ECDH or ECDSA. */
export function importP256Private(d: Uint8Array, pub: Uint8Array, alg: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", pointToJwk(pub, d), { name: alg, namedCurve: "P-256" }, false, alg === "ECDH" ? ["deriveBits"] : ["sign"]);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(info) }, key, bytes * 8));
}

export interface EncryptOptions {
  /** Application-server ephemeral key pair (tests only; normally generated per message). */
  asKeys?: { privateKey: Uint8Array; publicKey: Uint8Array };
  salt?: Uint8Array;
}

/**
 * RFC 8291 message encryption: a single aes128gcm record (rs = 4096) holding plaintext || 0x02.
 * Returns the full request body: salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext.
 */
export async function encryptWebPush(plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array> {
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new PermanentError("push payload too large");
  const uaKey = await crypto.subtle.importKey("jwk", pointToJwk(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  let asPriv: CryptoKey;
  let asPublic: Uint8Array;
  if (opts.asKeys) {
    asPriv = await importP256Private(opts.asKeys.privateKey, opts.asKeys.publicKey, "ECDH");
    asPublic = opts.asKeys.publicKey;
  } else {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPriv = kp.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  }
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asPriv, 256));
  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0" || ua_public || as_public, 32)
  const ikm = await hkdf(authSecret, ecdh, concatBytes(utf8.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", bs(cek), "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce) }, key, bs(concatBytes(plaintext, new Uint8Array([2])))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concatBytes(header, asPublic, ct);
}

/** Generate a VAPID key pair: base64url uncompressed public point (65 bytes) and raw private scalar (32 bytes). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { publicKey: base64urlEncode(pub), privateKey: jwk.d! };
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for a push service endpoint (RFC 8292). */
export async function vapidAuthorization(endpoint: string, env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new PermanentError("Web Push (VAPID) is not configured");
  const key = await importP256Private(base64urlDecode(env.VAPID_PRIVATE_KEY), base64urlDecode(env.VAPID_PUBLIC_KEY), "ECDSA");
  const jwt = await signJwt("ES256", key, { typ: "JWT" }, {
    aud: new URL(endpoint).origin,
    exp: now + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:ops@subetha.org",
  });
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

export const urgencyFor = (priority = 3) => (priority <= 2 ? "low" : priority === 3 ? "normal" : "high");

export function ttlFor(m: Envelope, now = Math.floor(Date.now() / 1000)): number {
  if (m.expires) return Math.max(0, Math.min(m.expires - now, 28 * 86400));
  return 86400;
}

export function parseSubscription(address: string): PushSubscriptionJSON {
  try {
    const s = JSON.parse(address) as PushSubscriptionJSON;
    if (/^https:\/\//.test(s.endpoint) && s.keys?.p256dh && s.keys?.auth) return s;
  } catch { /* fall through */ }
  throw new PermanentError("invalid push subscription");
}

registerSender("webpush", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const sub = parseSubscription(ep.address);
  const payload = utf8.encode(JSON.stringify(trimEnvelope(job.message, WEBPUSH_MAX_PAYLOAD)));
  const body = await encryptWebPush(payload, base64urlDecode(sub.keys.p256dh), base64urlDecode(sub.keys.auth));
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(sub.endpoint, env),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(ttlFor(job.message)),
    urgency: urgencyFor(job.message.priority),
  };
  // RFC 8030 Topic (≤32 base64url chars) replaces an undelivered push with the same topic. Keying it
  // on the message id makes retries idempotent without collapsing distinct messages.
  if (job.message.id && /^[A-Za-z0-9_-]{1,32}$/.test(job.message.id)) headers.topic = job.message.id;
  const r = await fetch(sub.endpoint, { method: "POST", headers, body: body as BodyInit, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (r.status === 404 || r.status === 410) {
    await unverifyEndpoint(env, ep.id);
    throw new PermanentError(`push subscription expired (HTTP ${r.status})`);
  }
  if (!r.ok) throw httpFailure(r.status, await r.text());
  return { detail: { status: r.status, location: r.headers.get("location") ?? undefined } };
});
