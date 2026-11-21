// XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha, RFC 8439). Pure TypeScript, no dependencies.
// Used only for optional E2EE of small messages, so clarity is preferred over speed.

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function quarter(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotl(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotl(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotl(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotl(s[b]! ^ s[c]!, 7);
}

function rounds(s: Uint32Array) {
  for (let i = 0; i < 10; i++) {
    quarter(s, 0, 4, 8, 12); quarter(s, 1, 5, 9, 13); quarter(s, 2, 6, 10, 14); quarter(s, 3, 7, 11, 15);
    quarter(s, 0, 5, 10, 15); quarter(s, 1, 6, 11, 12); quarter(s, 2, 7, 8, 13); quarter(s, 3, 4, 9, 14);
  }
}

function initState(key: Uint8Array, counter: number, nonce12: Uint8Array): Uint32Array {
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  for (let i = 0; i < 8; i++) s[4 + i] = u32le(key, i * 4);
  s[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) s[13 + i] = u32le(nonce12, i * 4);
  return s;
}

function chachaBlock(key: Uint8Array, counter: number, nonce12: Uint8Array): Uint8Array {
  const init = initState(key, counter, nonce12);
  const s = init.slice();
  rounds(s);
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const v = (s[i]! + init[i]!) >>> 0;
    out[i * 4] = v & 255; out[i * 4 + 1] = (v >>> 8) & 255; out[i * 4 + 2] = (v >>> 16) & 255; out[i * 4 + 3] = v >>> 24;
  }
  return out;
}

export function hchacha20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  for (let i = 0; i < 8; i++) s[4 + i] = u32le(key, i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = u32le(nonce16, i * 4);
  rounds(s);
  const out = new Uint8Array(32);
  const idx = [0, 1, 2, 3, 12, 13, 14, 15];
  idx.forEach((w, i) => {
    const v = s[w]!;
    out[i * 4] = v & 255; out[i * 4 + 1] = (v >>> 8) & 255; out[i * 4 + 2] = (v >>> 16) & 255; out[i * 4 + 3] = v >>> 24;
  });
  return out;
}

function chacha20Xor(key: Uint8Array, nonce12: Uint8Array, counter: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let off = 0, ctr = counter; off < data.length; off += 64, ctr++) {
    const ks = chachaBlock(key, ctr, nonce12);
    for (let i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i]! ^ ks[i]!;
  }
  return out;
}

function leBytesToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const r = leBytesToBig(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBytesToBig(key.subarray(16, 32));
  const p = (1n << 130n) - 5n;
  let acc = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.subarray(i, Math.min(i + 16, msg.length));
    const n = leBytesToBig(chunk) | (1n << BigInt(chunk.length * 8));
    acc = ((acc + n) * r) % p;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(acc & 255n);
    acc >>= 8n;
  }
  return out;
}

function pad16(n: number) {
  return new Uint8Array((16 - (n % 16)) % 16);
}

function le64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
}

function macData(aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const parts = [aad, pad16(aad.length), ct, pad16(ct.length), le64(aad.length), le64(ct.length)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function subkeyAndNonce(key: Uint8Array, nonce24: Uint8Array) {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  if (nonce24.length !== 24) throw new Error("nonce must be 24 bytes");
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = new Uint8Array(12);
  nonce12.set(nonce24.subarray(16, 24), 4);
  return { subkey, nonce12 };
}

/** Returns ciphertext || 16-byte tag. */
export function xchachaSeal(key: Uint8Array, nonce24: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const { subkey, nonce12 } = subkeyAndNonce(key, nonce24);
  const polyKey = chachaBlock(subkey, 0, nonce12).subarray(0, 32);
  const ct = chacha20Xor(subkey, nonce12, 1, plaintext);
  const tag = poly1305(polyKey, macData(aad, ct));
  const out = new Uint8Array(ct.length + 16);
  out.set(ct);
  out.set(tag, ct.length);
  return out;
}

/** Returns plaintext, or null if authentication fails. */
export function xchachaOpen(key: Uint8Array, nonce24: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array | null {
  if (sealed.length < 16) return null;
  const { subkey, nonce12 } = subkeyAndNonce(key, nonce24);
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const polyKey = chachaBlock(subkey, 0, nonce12).subarray(0, 32);
  const expect = poly1305(polyKey, macData(aad, ct));
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= expect[i]! ^ tag[i]!;
  if (diff !== 0) return null;
  return chacha20Xor(subkey, nonce12, 1, ct);
}
