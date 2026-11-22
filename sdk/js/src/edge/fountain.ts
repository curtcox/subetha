// Fountain-coded frames for animated QR (display → camera), wire-compatible with
// sdk/core/src/edge/qr.rs (spec §11.2). Systematic LT code, robust soliton degrees,
// peeling decoder. See ./web-qr.ts for rendering and scanning.
//
// Frame (big-endian): u8 version 1 · u32 payload length · u16 block size B ·
// u32 CRC-32 of the payload · u32 sequence number · B bytes (XOR of the frame's blocks).

import { crc32 } from "./crc.ts";
import { SplitMix64 } from "./splitmix.ts";

export const FOUNTAIN_VERSION = 1;
export const FOUNTAIN_HEADER_LEN = 15;
const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;

export class FountainError extends Error {
  readonly code: "bad_frame_size" | "too_large" | "malformed" | "version" | "mismatch";
  constructor(code: "bad_frame_size" | "too_large" | "malformed" | "version" | "mismatch", message: string) {
    super(message);
    this.code = code;
  }
}

/** Robust soliton CDF for `k` blocks; cdf[d-1] = P(degree <= d). */
export function robustSolitonCdf(k: number): number[] {
  const r = SOLITON_C * Math.log(k / SOLITON_DELTA) * Math.sqrt(k);
  const spike = r > 0 ? Math.min(Math.max(Math.floor(k / r), 1), k) : k;
  const mu: number[] = [];
  for (let i = 1; i <= k; i++) {
    const rho = i === 1 ? 1 / k : 1 / (i * (i - 1));
    let tau = 0;
    if (r > 0) {
      if (i < spike) tau = r / (i * k);
      else if (i === spike) tau = (r * Math.max(Math.log(r / SOLITON_DELTA), 0)) / k;
    }
    mu.push(rho + tau);
  }
  let z = 0;
  for (const m of mu) z += m;
  let acc = 0;
  for (let i = 0; i < k; i++) {
    acc += mu[i]! / z;
    mu[i] = acc;
  }
  if (k > 0) mu[k - 1] = 1;
  return mu;
}

/** Source block indices XORed into frame `seq`. */
export function frameBlocks(seq: number, k: number, crc: number, cdf: number[]): number[] {
  if (seq < k) return [seq];
  const rng = new SplitMix64(BigInt(seq >>> 0) ^ (BigInt(crc >>> 0) << 32n));
  const u = rng.nextF64();
  let d = cdf.findIndex((c) => u < c);
  d = d < 0 ? k : Math.min(d + 1, k);
  const idx = Array.from({ length: k }, (_, i) => i);
  for (let i = 0; i < d; i++) {
    const j = i + rng.below(k - i);
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, d);
}

interface Header { len: number; block: number; crc: number }
const blockCount = (h: Header) => Math.max(1, Math.ceil(h.len / h.block));
const sameHeader = (a: Header, b: Header) => a.len === b.len && a.block === b.block && a.crc === b.crc;

function xorInto(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i]! ^= src[i]!;
}

/** Endless frame stream for one payload. */
export class FountainEncoder {
  private readonly header: Header;
  private readonly blocks: Uint8Array[];
  private readonly cdf: number[];

  /** `frameSize` includes the 15-byte header; pick it from the QR version's capacity. */
  constructor(payload: Uint8Array, frameSize: number) {
    if (frameSize <= FOUNTAIN_HEADER_LEN || frameSize - FOUNTAIN_HEADER_LEN > 0xffff) {
      throw new FountainError("bad_frame_size", `frame size must exceed the ${FOUNTAIN_HEADER_LEN}-byte header and fit in u16`);
    }
    if (payload.length > 0xffffffff) throw new FountainError("too_large", "payload too large");
    const block = frameSize - FOUNTAIN_HEADER_LEN;
    this.header = { len: payload.length, block, crc: crc32(payload) };
    this.blocks = [];
    for (let o = 0; o < payload.length; o += block) {
      const b = new Uint8Array(block);
      b.set(payload.subarray(o, o + block));
      this.blocks.push(b);
    }
    if (this.blocks.length === 0) this.blocks.push(new Uint8Array(block));
    this.cdf = robustSolitonCdf(this.blocks.length);
  }

  /** K: a receiver needs a little more than this many frames. */
  get sourceBlocks(): number {
    return this.blocks.length;
  }

  frame(seq: number): Uint8Array {
    const { len, block, crc } = this.header;
    const f = new Uint8Array(FOUNTAIN_HEADER_LEN + block);
    const v = new DataView(f.buffer);
    f[0] = FOUNTAIN_VERSION;
    v.setUint32(1, len);
    v.setUint16(5, block);
    v.setUint32(7, crc);
    v.setUint32(11, seq >>> 0);
    const data = f.subarray(FOUNTAIN_HEADER_LEN);
    for (const i of frameBlocks(seq >>> 0, this.blocks.length, crc, this.cdf)) xorInto(data, this.blocks[i]!);
    return f;
  }

  *frames(start = 0): Generator<Uint8Array> {
    for (let s = start; ; s = (s + 1) >>> 0) yield this.frame(s);
  }
}

export type FountainProgress = { complete: false; known: number; total: number } | { complete: true };

interface Equation { blocks: Set<number>; data: Uint8Array }

/** Peeling decoder. Feed frames in any order; duplicates are ignored. */
export class FountainDecoder {
  private header: Header | null = null;
  private cdf: number[] = [];
  private blocks: (Uint8Array | null)[] = [];
  private known = 0;
  private pending: Equation[] = [];
  private seen = new Set<number>();
  private output: Uint8Array | null = null;

  /** Feeds one frame. Throws FountainError("mismatch") for a different transfer. */
  push(frame: Uint8Array): FountainProgress {
    if (frame.length < FOUNTAIN_HEADER_LEN) throw new FountainError("malformed", "malformed frame");
    if (frame[0] !== FOUNTAIN_VERSION) throw new FountainError("version", `unsupported frame version ${frame[0]}`);
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const h: Header = { len: v.getUint32(1), block: v.getUint16(5), crc: v.getUint32(7) };
    const seq = v.getUint32(11);
    const data = frame.subarray(FOUNTAIN_HEADER_LEN);
    if (h.block === 0 || data.length !== h.block) throw new FountainError("malformed", "malformed frame");
    if (!this.header) {
      this.header = h;
      const k = blockCount(h);
      this.cdf = robustSolitonCdf(k);
      this.blocks = new Array<Uint8Array | null>(k).fill(null);
    } else if (!sameHeader(this.header, h)) {
      throw new FountainError("mismatch", "frame belongs to a different transfer");
    }
    if (!this.output && !this.seen.has(seq)) {
      this.seen.add(seq);
      const k = this.blocks.length;
      this.add({ blocks: new Set(frameBlocks(seq, k, h.crc, this.cdf)), data: data.slice() });
      if (this.known === k) this.finish(h);
    }
    return this.progress();
  }

  progress(): FountainProgress {
    return this.output ? { complete: true } : { complete: false, known: this.known, total: this.blocks.length };
  }

  private add(eq: Equation): void {
    for (const i of [...eq.blocks]) {
      const b = this.blocks[i];
      if (b) {
        xorInto(eq.data, b);
        eq.blocks.delete(i);
      }
    }
    if (eq.blocks.size === 1) this.solve([...eq.blocks][0]!, eq.data);
    else if (eq.blocks.size > 1) this.pending.push(eq);
  }

  private solve(first: number, firstData: Uint8Array): void {
    const work: [number, Uint8Array][] = [[first, firstData]];
    while (work.length) {
      const [i, data] = work.pop()!;
      if (this.blocks[i]) continue;
      for (const eq of this.pending) if (eq.blocks.delete(i)) xorInto(eq.data, data);
      this.blocks[i] = data;
      this.known++;
      const rest: Equation[] = [];
      for (const eq of this.pending) {
        if (eq.blocks.size === 1) work.push([[...eq.blocks][0]!, eq.data]);
        else if (eq.blocks.size > 1) rest.push(eq);
      }
      this.pending = rest;
    }
  }

  private finish(h: Header): void {
    const out = new Uint8Array(this.blocks.length * h.block);
    this.blocks.forEach((b, i) => out.set(b!, i * h.block));
    const payload = out.slice(0, h.len);
    if (crc32(payload) === h.crc) {
      this.output = payload;
      this.pending = [];
    } else {
      this.reset(); // a corrupt frame got in; start over
    }
  }

  get result(): Uint8Array | null {
    return this.output;
  }

  get complete(): boolean {
    return this.output !== null;
  }

  reset(): void {
    this.header = null;
    this.cdf = [];
    this.blocks = [];
    this.known = 0;
    this.pending = [];
    this.seen = new Set();
    this.output = null;
  }
}
