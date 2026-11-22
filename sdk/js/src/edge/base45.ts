// Base45 (RFC 9285): binary as QR alphanumeric-mode text, ~97% efficient versus ~75% for
// base64 in byte mode. Animated QR frames are base45 text (spec §11.2).

export const BASE45_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

export function base45Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let n = bytes[i]! * 256 + bytes[i + 1]!;
    for (let j = 0; j < 3; j++) {
      out += BASE45_ALPHABET[n % 45];
      n = Math.floor(n / 45);
    }
  }
  if (bytes.length % 2) {
    const n = bytes[bytes.length - 1]!;
    out += BASE45_ALPHABET[n % 45]! + BASE45_ALPHABET[Math.floor(n / 45)]!;
  }
  return out;
}

export function base45Decode(s: string): Uint8Array {
  if (s.length % 3 === 1) throw new Error("invalid base45 length");
  const val = (c: string) => {
    const v = BASE45_ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`invalid base45 character ${JSON.stringify(c)}`);
    return v;
  };
  const out = new Uint8Array(Math.floor(s.length / 3) * 2 + (s.length % 3 ? 1 : 0));
  let o = 0;
  for (let i = 0; i < s.length; i += 3) {
    if (i + 2 < s.length) {
      const n = val(s[i]!) + val(s[i + 1]!) * 45 + val(s[i + 2]!) * 2025;
      if (n > 0xffff) throw new Error("invalid base45 triple");
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      const n = val(s[i]!) + val(s[i + 1]!) * 45;
      if (n > 0xff) throw new Error("invalid base45 pair");
      out[o++] = n;
    }
  }
  return out;
}
