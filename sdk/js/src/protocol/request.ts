// Device-signed HTTP requests (spec §8.1). Shared by the SDK (signing) and the relay (checking).
import { base64urlEncode, hexEncode, utf8 } from "./encoding.ts";
import type { DeviceKey } from "./sign.ts";

export const REQ_V2_DOMAIN = "subetha-req-v2";

/** Headers every v2 signature must list. */
export const REQUIRED_SIGNED_HEADERS = ["x-device-id", "x-device-time", "x-device-nonce"] as const;

/** Headers that can't be signed: the signature itself and the list of signed headers. */
const UNSIGNABLE = new Set(["x-device-signature", "x-device-signed-headers"]);

/**
 * Headers that change what a request does (content, routing, cost, idempotency). A relay rejects
 * a device-signed request carrying one of these unless the signature lists it. Includes every
 * ntfy alias the relay reads (spec §8), and a few more ntfy names so they stay covered if the
 * relay starts reading them.
 */
export const COVERED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "content-type", "content-encoding", "idempotency-key",
  "x-title", "title", "t",
  "x-priority", "priority", "prio", "p",
  "x-tags", "tags", "tag", "ta",
  "x-click", "click",
  "x-icon", "icon",
  "x-attach", "attach", "a",
  "x-markdown", "markdown", "md",
  "x-actions", "actions", "action",
  "x-filename", "filename", "file", "f",
  "x-message", "message", "m",
  "x-delay", "delay", "x-at", "at", "x-in", "in",
  "x-email", "email", "e", "x-call", "call",
  "x-cache", "cache", "x-firebase", "firebase", "x-unifiedpush", "unifiedpush", "up",
  "x-poll-id", "poll-id",
  "x-sender", "x-signature", "x-message-id", "x-time", "x-expires", "x-content-type", "x-hops",
  "x-route-mode", "x-max-cost", "x-deny", "x-allow", "x-deadline", "x-dry-run",
]);

const NAME_RE = /^[a-z0-9-]{1,64}$/;
export const MAX_SIGNED_HEADERS = 32;

/** Header values as signed: surrounding spaces and tabs removed (HTTP drops them anyway). */
export const canonicalHeaderValue = (v: string) => v.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * The string a device signs (spec §8.1):
 * `subetha-req-v2\nMETHOD\nhost\npath?query\nhex(sha256(body))` then `\nname:value` per signed
 * header, in the listed order. `host` and `path?query` are WHATWG `URL.host` and
 * `URL.pathname + URL.search`.
 */
export async function requestSigningInputV2(method: string, url: string, body: Uint8Array, headers: readonly (readonly [string, string])[]): Promise<string> {
  const u = new URL(url);
  const digest = hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource)));
  let s = `${REQ_V2_DOMAIN}\n${method.toUpperCase()}\n${u.host}\n${u.pathname}${u.search}\n${digest}`;
  for (const [n, v] of headers) s += `\n${n.toLowerCase()}:${canonicalHeaderValue(v)}`;
  return s;
}

/**
 * Checks an `X-Device-Signed-Headers` value. Returns the names, or an error message: names
 * must be lowercase, unique, include the X-Device-Id/-Time/-Nonce headers, and exclude the
 * signature headers.
 */
export function parseSignedHeaders(value: string): string[] | string {
  const names = value.split(",");
  if (names.length > MAX_SIGNED_HEADERS) return `at most ${MAX_SIGNED_HEADERS} signed headers`;
  const seen = new Set<string>();
  for (const n of names) {
    if (!NAME_RE.test(n)) return `invalid signed header name: ${JSON.stringify(n)}`;
    if (UNSIGNABLE.has(n)) return `${n} can't be signed`;
    if (seen.has(n)) return `duplicate signed header: ${n}`;
    seen.add(n);
  }
  for (const r of REQUIRED_SIGNED_HEADERS) if (!seen.has(r)) return `signed headers must include ${r}`;
  return names;
}

/**
 * Headers the SDKs don't sign: credentials, and headers HTTP stacks set or rewrite themselves.
 * None of them is covered.
 */
export const UNSIGNED_BY_CONVENTION: ReadonlySet<string> = new Set([
  "authorization", "host", "content-length", "connection", "transfer-encoding", "user-agent", "accept", "accept-encoding",
]);

/**
 * The SDKs' convention for which headers to sign and in what order: X-Device-Id, -Time, -Nonce,
 * then every other header the client sets (lowercased, sorted), except UNSIGNED_BY_CONVENTION
 * and other x-device-* headers. Header-name case and order don't matter on the wire; this just
 * makes signatures reproducible across SDKs.
 */
export function headersToSign(deviceId: string, time: number, nonce: string, headers: Record<string, string> | Iterable<[string, string]>): [string, string][] {
  const rest = new Map<string, string>();
  for (const [k, v] of Symbol.iterator in Object(headers) ? (headers as Iterable<[string, string]>) : Object.entries(headers)) {
    const n = k.toLowerCase();
    if (UNSIGNED_BY_CONVENTION.has(n) || n.startsWith("x-device-")) continue;
    rest.set(n, v);
  }
  return [
    ["x-device-id", deviceId],
    ["x-device-time", String(time)],
    ["x-device-nonce", nonce],
    ...[...rest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ];
}

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** A fresh single-use nonce: base64url of 16 random bytes. */
export const newRequestNonce = () => base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

/**
 * Signs a request (spec §8.1, `subetha-req-v2`). `headers` are the headers the request will
 * carry (Authorization, User-Agent and the like are skipped); send them unchanged, plus the returned X-Device-* headers.
 */
export async function signRequestV2(
  key: DeviceKey, method: string, url: string, body: Uint8Array, headers: Record<string, string> | Iterable<[string, string]> = {},
  nowSec = Math.floor(Date.now() / 1000), nonce = newRequestNonce(),
): Promise<Record<string, string>> {
  if (!NONCE_RE.test(nonce)) throw new Error("nonce must be 16-64 base64url characters");
  const signed = headersToSign(key.deviceId, nowSec, nonce, headers);
  if (signed.length > MAX_SIGNED_HEADERS) throw new Error(`at most ${MAX_SIGNED_HEADERS} signed headers`);
  const input = await requestSigningInputV2(method, url, body, signed);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8.encode(input) as BufferSource));
  return {
    "x-device-id": key.deviceId,
    "x-device-time": String(nowSec),
    "x-device-nonce": nonce,
    "x-device-signed-headers": signed.map(([n]) => n).join(","),
    "x-device-signature": base64urlEncode(sig),
  };
}
