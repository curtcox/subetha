// Dependency-free QR Code encoder (ISO/IEC 18004 model 2): byte and alphanumeric modes,
// versions 1–40, all four error-correction levels, automatic mask selection. Used to show
// animated-QR frames (spec §11.2); base45 text fits alphanumeric mode exactly.

import { utf8 } from "../protocol/encoding.ts";

export type QrEcl = "L" | "M" | "Q" | "H";
export interface QrCode {
  version: number;
  size: number;
  ecl: QrEcl;
  mask: number;
  /** size × size modules, row-major, 1 = dark. */
  modules: Uint8Array;
}

const ECL_INDEX: Record<QrEcl, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS: Record<QrEcl, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed [ecl][version]; index 0 unused.
const ECC_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const ECC_BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export const QR_ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/** Modules available for data and ECC (everything but function patterns). */
function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

/** Data codewords (bytes) a symbol holds. */
export function qrDataCodewords(ver: number, ecl: QrEcl): number {
  const e = ECL_INDEX[ecl];
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e]![ver]! * ECC_BLOCKS[e]![ver]!;
}

type Mode = "alphanumeric" | "byte";
const countBits = (mode: Mode, ver: number) =>
  mode === "alphanumeric" ? (ver <= 9 ? 9 : ver <= 26 ? 11 : 13) : ver <= 9 ? 8 : 16;

/** Largest number of characters (alphanumeric) or bytes (byte mode) a symbol holds. */
export function qrCapacity(ver: number, ecl: QrEcl, mode: Mode): number {
  const bits = qrDataCodewords(ver, ecl) * 8 - 4 - countBits(mode, ver);
  if (mode === "byte") return Math.min(Math.floor(bits / 8), (1 << countBits(mode, ver)) - 1);
  const n = Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
  return Math.min(n, (1 << countBits(mode, ver)) - 1);
}

class BitBuffer {
  bits: number[] = [];
  put(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

// ---- Reed–Solomon over GF(256), polynomial 0x11D ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function rsGenerator(degree: number): Uint8Array {
  // Coefficients highest first, leading 1 omitted.
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = gfMul(g[j]!, root) ^ (j + 1 < degree ? g[j + 1]! : 0);
    }
    root = gfMul(root, 2);
  }
  return g;
}

function rsRemainder(data: Uint8Array, gen: Uint8Array): Uint8Array {
  const r = new Uint8Array(gen.length);
  for (const b of data) {
    const f = b ^ r[0]!;
    r.copyWithin(0, 1);
    r[r.length - 1] = 0;
    for (let i = 0; i < r.length; i++) r[i]! ^= gfMul(gen[i]!, f);
  }
  return r;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Matrix {
  readonly size: number;
  readonly dark: Uint8Array;
  readonly fn: Uint8Array;
  readonly version: number;
  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = new Uint8Array(this.size * this.size);
    this.fn = new Uint8Array(this.size * this.size);
  }
  set(x: number, y: number, dark: boolean): void {
    this.dark[y * this.size + x] = dark ? 1 : 0;
    this.fn[y * this.size + x] = 1;
  }
  get(x: number, y: number): number {
    return this.dark[y * this.size + x]!;
  }

  drawFunctionPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= s || y >= s) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    pos.forEach((cy, i) => pos.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    this.drawFormat("L", 0); // reserve; redrawn after masking
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = s - 11 + (i % 3), b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  }

  drawFormat(ecl: QrEcl, mask: number): void {
    const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true); // dark module
  }

  drawCodewords(data: Uint8Array): void {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let v = 0; v < s; v++) {
        const y = upward ? s - 1 - v : v;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (this.fn[y * s + x] || i >= data.length * 8) continue;
          this.dark[y * s + x] = (data[i >>> 3]! >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }

  applyMask(mask: number): void {
    const s = this.size;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        if (this.fn[y * s + x]) continue;
        let inv: boolean;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (inv) this.dark[y * s + x]! ^= 1;
      }
    }
  }

  penalty(): number {
    const s = this.size;
    let p = 0;
    const line = (get: (i: number) => number) => {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) p += 3 + run - 5;
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 with four light modules on either side.
      for (let i = 0; i + 11 <= s; i++) {
        const w = Array.from({ length: 11 }, (_, k) => get(i + k)).join("");
        if (w === "10111010000" || w === "00001011101") p += 40;
      }
    };
    for (let y = 0; y < s; y++) line((x) => this.get(x, y));
    for (let x = 0; x < s; x++) line((y) => this.get(x, y));
    let dark = 0;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const c = this.get(x, y);
        dark += c;
        if (x + 1 < s && y + 1 < s && c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) p += 3;
      }
    }
    p += Math.floor(Math.abs((dark * 100) / (s * s) - 50) / 5) * 10;
    return p;
  }
}

export interface QrOptions {
  ecl?: QrEcl;
  minVersion?: number;
  maxVersion?: number;
  /** Force a mask (0–7); chosen by penalty score otherwise. */
  mask?: number;
}

/** Encodes text (alphanumeric mode when it fits the QR alphanumeric set) or bytes. */
export function encodeQr(data: string | Uint8Array, opts: QrOptions = {}): QrCode {
  const ecl = opts.ecl ?? "M";
  const minV = opts.minVersion ?? 1;
  const maxV = opts.maxVersion ?? 40;
  const isAlnum = typeof data === "string" && [...data].every((c) => QR_ALPHANUMERIC.includes(c));
  const mode: Mode = isAlnum ? "alphanumeric" : "byte";
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  const count = isAlnum ? (data as string).length : bytes.length;

  let ver = minV;
  for (; ver <= maxV; ver++) if (count <= qrCapacity(ver, ecl, mode)) break;
  if (ver > maxV) throw new RangeError(`data too long for a QR code (${count} ${mode} units)`);

  const bb = new BitBuffer();
  if (isAlnum) {
    const s = data as string;
    bb.put(0b0010, 4);
    bb.put(s.length, countBits(mode, ver));
    for (let i = 0; i + 1 < s.length; i += 2) bb.put(QR_ALPHANUMERIC.indexOf(s[i]!) * 45 + QR_ALPHANUMERIC.indexOf(s[i + 1]!), 11);
    if (s.length % 2) bb.put(QR_ALPHANUMERIC.indexOf(s[s.length - 1]!), 6);
  } else {
    bb.put(0b0100, 4);
    bb.put(bytes.length, countBits(mode, ver));
    for (const b of bytes) bb.put(b, 8);
  }
  const capBits = qrDataCodewords(ver, ecl) * 8;
  bb.put(0, Math.min(4, capBits - bb.bits.length));
  bb.put(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capBits; pad ^= 0xec ^ 0x11) bb.put(pad, 8);
  const dataCw = new Uint8Array(bb.bits.length / 8);
  bb.bits.forEach((b, i) => (dataCw[i >>> 3]! |= b << (7 - (i & 7))));

  // Split into blocks, add ECC, interleave.
  const e = ECL_INDEX[ecl];
  const nBlocks = ECC_BLOCKS[e]![ver]!;
  const eccLen = ECC_PER_BLOCK[e]![ver]!;
  const rawCw = Math.floor(rawDataModules(ver) / 8);
  const nShort = nBlocks - (rawCw % nBlocks);
  const shortLen = Math.floor(rawCw / nBlocks);
  const gen = rsGenerator(eccLen);
  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const len = shortLen - eccLen + (i < nShort ? 0 : 1);
    const d = dataCw.subarray(k, k + len);
    k += len;
    blocks.push({ data: d, ecc: rsRemainder(d, gen) });
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLen - eccLen; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) out.push(b.ecc[i]!);

  const base = new Matrix(ver);
  base.drawFunctionPatterns();
  base.drawCodewords(Uint8Array.from(out));
  const tryMask = (mask: number) => {
    const m = new Matrix(ver);
    m.dark.set(base.dark);
    m.fn.set(base.fn);
    m.applyMask(mask);
    m.drawFormat(ecl, mask);
    return m;
  };
  let best: Matrix | null = null;
  let bestMask = 0;
  if (opts.mask !== undefined) {
    best = tryMask(opts.mask);
    bestMask = opts.mask;
  } else {
    let bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = tryMask(mask);
      const p = m.penalty();
      if (p < bestP) [best, bestP, bestMask] = [m, p, mask];
    }
  }
  return { version: ver, size: best!.size, ecl, mask: bestMask, modules: best!.dark };
}

/** Draws a QR code on a 2D canvas context with a quiet zone of `margin` modules. */
export function drawQr(
  ctx: { fillStyle: unknown; fillRect(x: number, y: number, w: number, h: number): void },
  qr: QrCode,
  scale: number,
  margin = 4,
): void {
  const full = (qr.size + margin * 2) * scale;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, full, full);
  ctx.fillStyle = "#000";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  }
}
