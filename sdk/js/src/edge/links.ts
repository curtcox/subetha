// Platform-independent link drivers for edge transports. The web shims (./web-*.ts) and
// tests feed them samples, scanned strings, or BLE chunks; native shims can do the same.
//
// One-way links (audio, QR) carry a single gossip `deliver` message (spec §11.4), so the
// receiving GossipNode applies the usual checks: dedupe, expiry, hops, signatures.

import type { Envelope } from "../protocol/envelope.ts";
import { demodulate, resample, AUDIO_SAMPLE_RATE } from "./audio.ts";
import { base45Decode, base45Encode } from "./base45.ts";
import { chunk, DEFAULT_ATT_MTU, Reassembler } from "./ble.ts";
import { FountainDecoder, FountainEncoder, FountainError, type FountainProgress } from "./fountain.ts";
import { encodeGossip, gossipSession, GossipNode, parseGossip } from "./gossip.ts";
import { qrCapacity, type QrEcl } from "./qrcode.ts";

/** The payload one-way links carry for a set of envelopes. */
export function deliverPayload(envelopes: Envelope[]): Uint8Array {
  return encodeGossip({ type: "deliver", envelopes });
}

/** Hands a payload from a one-way link to a node; returns the new messages for the app. */
export async function acceptPayload(node: GossipNode, payload: Uint8Array): Promise<Envelope[]> {
  const msg = parseGossip(payload);
  if (!msg || msg.type !== "deliver") return [];
  return (await node.handle(msg)).delivered;
}

// ---- audio ----

export interface AudioReceiverOptions {
  /** Input sample rate (resampled to 48 kHz). */
  sampleRate: number;
  /** Longest frame to look for, in seconds (50 bytes/s). Default 6. */
  windowSeconds?: number;
  /** How often to scan, in seconds. Default 0.5. */
  scanSeconds?: number;
  onPayload: (payload: Uint8Array) => void;
}

/** Buffers microphone samples and scans them for modem frames. */
export class AudioFrameReceiver {
  private buf: Float32Array;
  private len = 0;
  private sinceScan = 0;
  private readonly scanEvery: number;
  private readonly opts: AudioReceiverOptions;
  constructor(opts: AudioReceiverOptions) {
    this.opts = opts;
    this.buf = new Float32Array(Math.ceil((opts.windowSeconds ?? 6) * AUDIO_SAMPLE_RATE));
    this.scanEvery = Math.ceil((opts.scanSeconds ?? 0.5) * AUDIO_SAMPLE_RATE);
  }

  push(samples: Float32Array): void {
    const x = resample(samples, this.opts.sampleRate);
    if (x.length >= this.buf.length) {
      this.buf.set(x.subarray(x.length - this.buf.length));
      this.len = this.buf.length;
    } else {
      const keep = Math.min(this.len, this.buf.length - x.length);
      this.buf.copyWithin(0, this.len - keep, this.len);
      this.buf.set(x, keep);
      this.len = keep + x.length;
    }
    this.sinceScan += x.length;
    if (this.sinceScan >= this.scanEvery) {
      this.sinceScan = 0;
      const p = demodulate(this.buf.subarray(0, this.len));
      if (p) {
        this.len = 0; // don't decode the same frame twice
        this.opts.onPayload(p);
      }
    }
  }
}

// ---- animated QR ----

/** Fountain frame size (bytes) that fills a QR version as base45 alphanumeric text. */
export function qrFrameSize(version: number, ecl: QrEcl = "L"): number {
  const chars = qrCapacity(version, ecl, "alphanumeric");
  return Math.floor(chars / 3) * 2 + (chars % 3 === 2 ? 1 : 0);
}

/** Yields the base45 text for each animated-QR frame of `payload`. */
export function qrFrameTexts(payload: Uint8Array, version = 12, ecl: QrEcl = "L"): { sourceBlocks: number; text: (seq: number) => string } {
  const enc = new FountainEncoder(payload, qrFrameSize(version, ecl));
  return { sourceBlocks: enc.sourceBlocks, text: (seq) => base45Encode(enc.frame(seq)) };
}

/** Collects scanned QR strings into a payload. Switches to a new transfer automatically. */
export class QrFrameReceiver {
  private dec = new FountainDecoder();
  private delivered = false;
  private readonly onPayload: (payload: Uint8Array) => void;
  constructor(onPayload: (payload: Uint8Array) => void) {
    this.onPayload = onPayload;
  }

  push(text: string): FountainProgress | null {
    let frame: Uint8Array;
    try {
      frame = base45Decode(text.trim());
    } catch {
      return null; // not one of ours
    }
    let p: FountainProgress;
    try {
      p = this.dec.push(frame);
    } catch (e) {
      if (!(e instanceof FountainError)) throw e;
      if (e.code !== "mismatch") return null;
      this.dec.reset();
      this.delivered = false;
      p = this.dec.push(frame);
    }
    if (p.complete && !this.delivered) {
      this.delivered = true;
      this.onPayload(this.dec.result!);
    }
    return p;
  }
}

// ---- BLE ----

/**
 * One gossip session over a BLE connection: chunks outgoing gossip messages for `write` and
 * reassembles incoming chunks. Works on either side (central or peripheral).
 */
export class BleLink {
  private seq = 0;
  private readonly reasm = new Reassembler();
  private readonly session: ReturnType<typeof gossipSession>;
  private readonly attMtu: number;
  constructor(
    node: GossipNode,
    write: (chunk: Uint8Array) => Promise<void> | void,
    onMessage: (env: Envelope) => void,
    attMtu = DEFAULT_ATT_MTU,
  ) {
    this.attMtu = attMtu;
    this.session = gossipSession(node, async (bytes) => {
      const seq = this.seq;
      this.seq = (this.seq + 1) & 0xffff;
      for (const c of chunk(seq, bytes, this.attMtu)) await write(c);
    }, onMessage);
  }

  /** Feeds one notification/write from the peer. Bad chunks are dropped. */
  async receive(c: Uint8Array): Promise<void> {
    let msg: Uint8Array | null;
    try {
      msg = this.reasm.push(c);
    } catch {
      return;
    }
    this.reasm.prune(Date.now(), 30_000);
    if (msg) await this.session.receive(msg);
  }

  /** Sends our summary (on connect, and after publishing). */
  resync(): Promise<void> {
    return this.session.resync();
  }
}
