import { base32Encode, base64urlDecode, hexEncode, utf8 } from "@subetha/sdk/protocol";

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  return hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", utf8.encode(key) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexEncode(new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(data) as BufferSource)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function randomBase32(bytes: number): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomDigits(n: number): string {
  const b = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(b, (x) => String(x % 10)).join("");
}

export function b64urlJson<T>(s: string): T {
  return JSON.parse(utf8.decode(base64urlDecode(s))) as T;
}
