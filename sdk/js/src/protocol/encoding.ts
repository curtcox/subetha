// Byte encodings used by the protocol. Dependency-free; works in browsers, Node, Deno, Bun, Workers.

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const str = s.toLowerCase().replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of str) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >>> 18]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[n >>> 18]! + B64[(n >>> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[n >>> 18]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]!;
  }
  return out;
}

/** Accepts base64url or standard base64, with or without padding. */
export function base64urlDecode(s: string): Uint8Array {
  const str = s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of str) {
    const i = B64.indexOf(ch);
    if (i < 0) throw new Error(`invalid base64 character: ${ch}`);
    value = (value << 6) | i;
    bits += 6;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function hexEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Hermes (React Native) lacks TextDecoder in some versions, and TextEncoder before RN 0.74.
const g = globalThis as { TextEncoder?: typeof TextEncoder; TextDecoder?: typeof TextDecoder };

/** UTF-8 encoding without TextEncoder (lone surrogates become U+FFFD, as TextEncoder does). */
export function utf8EncodeFallback(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** UTF-8 decoding without TextDecoder; malformed sequences become U+FFFD. */
export function utf8DecodeFallback(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; ) {
    const x = b[i]!;
    let need = 0;
    let c = 0;
    let min = 0;
    if (x < 0x80) {
      out += String.fromCharCode(x);
      i++;
      continue;
    } else if (x >= 0xc2 && x <= 0xdf) [need, c, min] = [1, x & 31, 0x80];
    else if (x >= 0xe0 && x <= 0xef) [need, c, min] = [2, x & 15, 0x800];
    else if (x >= 0xf0 && x <= 0xf4) [need, c, min] = [3, x & 7, 0x10000];
    else {
      out += "\ufffd";
      i++;
      continue;
    }
    let j = 1;
    for (; j <= need && i + j < b.length && (b[i + j]! & 0xc0) === 0x80; j++) c = (c << 6) | (b[i + j]! & 63);
    if (j <= need || c < min || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) {
      out += "\ufffd";
      i += j; // the lead byte and the continuation bytes read so far
      continue;
    }
    out += String.fromCodePoint(c);
    i += need + 1;
  }
  return out;
}

export const utf8 = {
  encode: (s: string): Uint8Array => (g.TextEncoder ? new g.TextEncoder().encode(s) : utf8EncodeFallback(s)),
  decode: (b: Uint8Array): string => (g.TextDecoder ? new g.TextDecoder().decode(b) : utf8DecodeFallback(b)),
};

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
