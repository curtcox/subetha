// Data-over-sound modem: 16-FSK at 48 kHz, wire-compatible with sdk/core/src/edge/audio.rs
// (spec §11.1). Pure DSP: see ./web-audio.ts for speakers and microphones.
//
// Frame: preamble (8 symbols alternating 1500/5600 Hz), sync 0x2D 0xD4, u16 length, payload,
// CRC-16/CCITT-FALSE over length || payload. One 10 ms symbol (480 samples) per nibble, data
// tone 2000 + 200·k Hz. 50 bytes/s.

import { crc16 } from "./crc.ts";

export const AUDIO_SAMPLE_RATE = 48_000;
export const SYMBOL_SAMPLES = 480;
export const MAX_AUDIO_PAYLOAD = 1024;
export const AUDIO_AMPLITUDE = 0.5;

const PREAMBLE_TONES = [1500, 5600] as const;
const PREAMBLE_SYMBOLS = 8;
const SYNC = [0x2d, 0xd4] as const;
const DATA_BASE_HZ = 2000;
const DATA_STEP_HZ = 200;
const SEARCH_STEP = SYMBOL_SAMPLES / 8;
const FADE_SAMPLES = 48;
const CANDIDATES = 6;

const dataTone = (nibble: number) => DATA_BASE_HZ + DATA_STEP_HZ * nibble;
const preambleTone = (i: number) => PREAMBLE_TONES[i % 2]!;

/** Number of PCM samples a payload of `len` bytes modulates to. */
export function audioFrameSamples(len: number): number {
  return (PREAMBLE_SYMBOLS + 2 * (SYNC.length + 2 + len + 2)) * SYMBOL_SAMPLES;
}

/** The tone (Hz) of every symbol in the frame for `payload`, preamble first. */
export function audioTones(payload: Uint8Array): number[] {
  if (payload.length > MAX_AUDIO_PAYLOAD) throw new RangeError("audio payload too large");
  const body = new Uint8Array(payload.length + 2);
  body[0] = payload.length >> 8;
  body[1] = payload.length & 0xff;
  body.set(payload, 2);
  const crc = crc16(body);
  const bytes = [...SYNC, ...body, crc >> 8, crc & 0xff];
  const tones: number[] = [];
  for (let i = 0; i < PREAMBLE_SYMBOLS; i++) tones.push(preambleTone(i));
  for (const b of bytes) tones.push(dataTone(b >> 4), dataTone(b & 15));
  return tones;
}

/** Modulates `payload` into mono PCM at 48 kHz. */
export function modulate(payload: Uint8Array): Float32Array {
  const tones = audioTones(payload);
  const out = new Float32Array(tones.length * SYMBOL_SAMPLES);
  const w = (2 * Math.PI) / AUDIO_SAMPLE_RATE;
  tones.forEach((f, s) => {
    // Whole cycles per symbol, so restarting the phase at 0 is continuous.
    for (let n = 0; n < SYMBOL_SAMPLES; n++) out[s * SYMBOL_SAMPLES + n] = AUDIO_AMPLITUDE * Math.sin(w * f * n);
  });
  const total = out.length;
  for (let i = 0; i < Math.min(FADE_SAMPLES, total / 2); i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / FADE_SAMPLES);
    out[i]! *= g;
    out[total - 1 - i]! *= g;
  }
  return out;
}

/** Goertzel power of `freq` over one symbol window starting at `start`. */
function power(x: ArrayLike<number>, start: number, freq: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / AUDIO_SAMPLE_RATE);
  let s1 = 0;
  let s2 = 0;
  for (let i = start; i < start + SYMBOL_SAMPLES; i++) {
    const s0 = x[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function preambleScore(x: ArrayLike<number>, start: number): number {
  let score = 0;
  for (let i = 0; i < PREAMBLE_SYMBOLS; i++) {
    const at = start + i * SYMBOL_SAMPLES;
    score += power(x, at, preambleTone(i)) - power(x, at, preambleTone(i + 1));
  }
  return score;
}

function demodSymbol(x: ArrayLike<number>, start: number): number {
  let best = 0;
  let bestP = -Infinity;
  for (let k = 0; k < 16; k++) {
    const p = power(x, start, dataTone(k));
    if (p > bestP) [best, bestP] = [k, p];
  }
  return best;
}

function readBytes(x: ArrayLike<number>, start: number, sym: number, count: number): Uint8Array | null {
  const at = (j: number) => start + (PREAMBLE_SYMBOLS + sym + j) * SYMBOL_SAMPLES;
  if (at(2 * count) > x.length) return null;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (demodSymbol(x, at(2 * i)) << 4) | demodSymbol(x, at(2 * i + 1));
  return out;
}

function decodeAt(x: ArrayLike<number>, start: number): Uint8Array | null {
  const head = readBytes(x, start, 0, 4);
  if (!head || head[0] !== SYNC[0] || head[1] !== SYNC[1]) return null;
  const len = (head[2]! << 8) | head[3]!;
  if (len > MAX_AUDIO_PAYLOAD) return null;
  const rest = readBytes(x, start, 8, len + 2);
  if (!rest) return null;
  const body = new Uint8Array(len + 2);
  body.set(head.subarray(2, 4));
  body.set(rest.subarray(0, len), 2);
  const crc = crc16(body);
  return rest[len] === crc >> 8 && rest[len + 1] === (crc & 0xff) ? rest.slice(0, len) : null;
}

/** Finds and decodes the first valid frame in mono 48 kHz PCM, or null. */
export function demodulate(x: ArrayLike<number>): Uint8Array | null {
  const min = audioFrameSamples(0);
  if (x.length < min) return null;
  const last = x.length - min;
  const scored: [number, number][] = [];
  for (let o = 0; o <= last; o += SEARCH_STEP) {
    const s = preambleScore(x, o);
    if (s > 0) scored.push([o, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const tried: number[] = [];
  for (const [coarse] of scored) {
    if (tried.length >= CANDIDATES) break;
    if (tried.some((t) => Math.abs(t - coarse) < SYMBOL_SAMPLES)) continue;
    tried.push(coarse);
    const lo = Math.max(0, coarse - SEARCH_STEP);
    const hi = Math.min(coarse + SEARCH_STEP, last);
    let best = coarse;
    let bestS = -Infinity;
    for (let o = lo; o <= hi; o += 4) {
      const s = preambleScore(x, o);
      if (s > bestS) [best, bestS] = [o, s];
    }
    const p = decodeAt(x, best);
    if (p) return p;
  }
  return null;
}

/**
 * Linear-interpolation resampler, for microphones that don't run at 48 kHz. Good enough for
 * the 1.5–5.6 kHz tones this modem uses at common input rates (44.1, 16 kHz and up).
 */
export function resample(x: Float32Array, fromRate: number, toRate = AUDIO_SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return x;
  const n = Math.floor((x.length * toRate) / fromRate);
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return out;
}

/**
 * `resample` for a stream that arrives in blocks. It keeps its phase and the previous block's last
 * sample, so block boundaries neither drop nor repeat time. (Resampling each block on its own loses
 * a fraction of a sample per block: with 128-sample AudioWorklet blocks at 44.1 kHz that's 0.23%,
 * more than a symbol over a long frame.)
 */
export class Resampler {
  private pos = 0; // the next output's position, in input samples from the start of the next block
  private prev = 0; // the previous block's last sample (input index -1)
  private readonly step: number;
  readonly fromRate: number;
  readonly toRate: number;
  constructor(fromRate: number, toRate = AUDIO_SAMPLE_RATE) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.step = fromRate / toRate;
  }

  /** Resamples the next block. Outputs that need the next block's first sample wait for it. */
  push(x: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return x;
    const m = x.length;
    if (m === 0) return new Float32Array(0);
    const n = Math.max(0, Math.ceil((m - 1 - this.pos) / this.step)); // positions before m - 1
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.pos + i * this.step;
      const j = Math.floor(p);
      const f = p - j;
      const a = j < 0 ? this.prev : x[j]!;
      out[i] = a * (1 - f) + (x[j + 1] ?? a) * f; // x[m] only through rounding, where f ≈ 0
    }
    this.pos += n * this.step - m;
    this.prev = x[m - 1]!;
    return out;
  }
}
