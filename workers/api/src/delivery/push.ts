// Shared helpers for the push transports (Web Push, FCM, APNs): payload trimming, JWT signing
// with WebCrypto, and retiring endpoints that a push service says are gone.
import { base64urlDecode, base64urlEncode, utf8, type Envelope } from "@subetha/sdk/protocol";
import { syncTopicSubscriptions } from "../control.ts";
import type { Env } from "../types.ts";

/** Fields that survive trimming no matter what (the message body may still be shortened). */
const KEEP = new Set(["id", "topic", "title", "message", "priority"]);

const size = (v: unknown) => utf8.encode(JSON.stringify(v)).length;

/** Cut a string to at most `max` UTF-8 bytes without splitting a code point, adding "…". */
export function truncateUtf8(s: string, max: number): string {
  if (utf8.encode(s).length <= max) return s;
  let out = "";
  let n = 0;
  const budget = Math.max(0, max - 3); // "…" is 3 bytes
  for (const ch of s) {
    const b = utf8.encode(ch).length;
    if (n + b > budget) break;
    out += ch;
    n += b;
  }
  return out + "…";
}

/**
 * Shrink an envelope so its JSON is at most `maxBytes`: drop optional fields largest first, then
 * shorten message and title. Sets `truncated: true` when anything was removed so apps know to
 * fetch the full message by id.
 */
export function trimEnvelope(m: Envelope, maxBytes: number): Envelope {
  if (size(m) <= maxBytes) return m;
  const e: Envelope = { ...m, truncated: true };
  const optional = Object.keys(e).filter((k) => !KEEP.has(k) && k !== "truncated").sort((a, b) => size(e[b]) - size(e[a]));
  for (const k of optional) {
    if (size(e) <= maxBytes) return e;
    delete e[k];
  }
  for (const k of ["message", "title"] as const) {
    const v = e[k];
    if (typeof v !== "string" || size(e) <= maxBytes) continue;
    if (k === "message" && m.enc) { delete e.message; continue; } // ciphertext can't be cut
    // JSON escaping makes encoded length differ from UTF-8 length, so binary-search the longest
    // prefix (in code points) that fits.
    const chars = [...v];
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      e[k] = chars.slice(0, mid).join("") + "…";
      if (size(e) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    e[k] = chars.slice(0, lo).join("") + "…";
    if (size(e) > maxBytes) e[k] = "";
  }
  return e;
}

/** Title/body for an OS notification banner. */
export function alertText(m: Envelope, maxBody = 512): { title: string; body: string } {
  const body = m.enc ? "[encrypted message — open in a SubEtha app]" : (m.message ?? "");
  return { title: truncateUtf8(m.title || m.topic, 200), body: truncateUtf8(body, maxBody) };
}

/** The push service says this endpoint is gone: stop using it until the client re-registers. */
export async function unverifyEndpoint(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE endpoints SET verified_at = NULL WHERE id = ?").bind(id).run();
  try {
    const { results } = await env.DB.prepare("SELECT DISTINCT topic FROM subscriptions WHERE endpoint_id = ?").bind(id).all<{ topic: string }>();
    for (const r of results) await syncTopicSubscriptions(env, r.topic);
  } catch {
    // Best effort: loadEndpoint already refuses unverified endpoints.
  }
}

const b64json = (o: unknown) => base64urlEncode(utf8.encode(JSON.stringify(o)));

/**
 * Compact JWS. WebCrypto's ECDSA output is already the raw r||s (64 bytes for P-256) that JWS
 * ES256 requires, so it is used as-is (no DER).
 */
export async function signJwt(alg: "ES256" | "RS256", key: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const input = `${b64json({ alg, ...header })}.${b64json(claims)}`;
  const params = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const sig = new Uint8Array(await crypto.subtle.sign(params, key, utf8.encode(input) as BufferSource));
  return `${input}.${base64urlEncode(sig)}`;
}

/** DER body of a PEM block (e.g. "-----BEGIN PRIVATE KEY-----"). */
export function pemToDer(pem: string): Uint8Array {
  return base64urlDecode(pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, ""));
}
