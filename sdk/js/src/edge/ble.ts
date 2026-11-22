// Bluetooth LE GATT identifiers and MTU-sized chunking, wire-compatible with
// sdk/core/src/edge/ble.rs (spec §11.3). See ./web-bluetooth.ts for the Web Bluetooth shim.
//
// Chunk (big-endian): u16 message seq · u16 chunk index · u16 chunk count · data.
// The message is payload || CRC-16/CCITT-FALSE(payload), split into ATT_MTU - 3 - 6 byte chunks.

import { crc16 } from "./crc.ts";

export const BLE_SERVICE_UUID = "53554245-5448-4100-8000-5ebe7a000000";
export const BLE_INBOX_UUID = "53554245-5448-4100-8000-5ebe7a000001";
export const BLE_OUTBOX_UUID = "53554245-5448-4100-8000-5ebe7a000002";
export const BLE_SUMMARY_UUID = "53554245-5448-4100-8000-5ebe7a000003";
export const BLE_VERSION_UUID = "53554245-5448-4100-8000-5ebe7a000004";
export const BLE_PROTOCOL_VERSION = 1;
export const DEFAULT_ATT_MTU = 23;
export const MAX_ATT_MTU = 517;
export const CHUNK_HEADER = 6;
const ATT_HEADER = 3;

export class BleError extends Error {
  readonly code: "mtu_too_small" | "too_large" | "malformed" | "inconsistent" | "bad_crc";
  constructor(code: "mtu_too_small" | "too_large" | "malformed" | "inconsistent" | "bad_crc", message: string) {
    super(message);
    this.code = code;
  }
}

export function chunkCapacity(attMtu: number): number {
  const cap = attMtu - ATT_HEADER - CHUNK_HEADER;
  if (cap <= 0) throw new BleError("mtu_too_small", `ATT MTU ${attMtu} is too small`);
  return cap;
}

/** Splits `payload` into chunks for one ATT MTU. */
export function chunk(seq: number, payload: Uint8Array, attMtu: number): Uint8Array[] {
  const cap = chunkCapacity(attMtu);
  const msg = new Uint8Array(payload.length + 2);
  msg.set(payload);
  const crc = crc16(payload);
  msg[payload.length] = crc >> 8;
  msg[payload.length + 1] = crc & 0xff;
  const count = Math.ceil(msg.length / cap);
  if (count > 0xffff) throw new BleError("too_large", "message needs more than 65535 chunks");
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const data = msg.subarray(i * cap, (i + 1) * cap);
    const c = new Uint8Array(CHUNK_HEADER + data.length);
    const v = new DataView(c.buffer);
    v.setUint16(0, seq & 0xffff);
    v.setUint16(2, i);
    v.setUint16(4, count);
    c.set(data, CHUNK_HEADER);
    out.push(c);
  }
  return out;
}

interface Partial { count: number; parts: Map<number, Uint8Array>; startedMs: number }

/** Reassembles chunks from one connection (out of order, duplicated, interleaved). */
export class Reassembler {
  private partial = new Map<number, Partial>();

  /** Adds a chunk; returns the payload when its message is complete. */
  push(c: Uint8Array, nowMs = Date.now()): Uint8Array | null {
    if (c.length < CHUNK_HEADER) throw new BleError("malformed", "malformed chunk");
    const v = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const seq = v.getUint16(0);
    const index = v.getUint16(2);
    const count = v.getUint16(4);
    if (count === 0 || index >= count) throw new BleError("malformed", "malformed chunk");
    let p = this.partial.get(seq);
    if (!p) {
      p = { count, parts: new Map(), startedMs: nowMs };
      this.partial.set(seq, p);
    }
    if (p.count !== count) {
      this.partial.delete(seq);
      throw new BleError("inconsistent", "chunk disagrees with earlier chunks of the same message");
    }
    if (!p.parts.has(index)) p.parts.set(index, c.slice(CHUNK_HEADER));
    if (p.parts.size < count) return null;
    this.partial.delete(seq);
    let len = 0;
    for (const part of p.parts.values()) len += part.length;
    const msg = new Uint8Array(len);
    let o = 0;
    for (let i = 0; i < count; i++) {
      const part = p.parts.get(i)!;
      msg.set(part, o);
      o += part.length;
    }
    if (msg.length < 2) throw new BleError("malformed", "malformed chunk");
    const payload = msg.slice(0, msg.length - 2);
    const crc = crc16(payload);
    if (msg[msg.length - 2] !== crc >> 8 || msg[msg.length - 1] !== (crc & 0xff)) {
      throw new BleError("bad_crc", "reassembled message failed its CRC");
    }
    return payload;
  }

  /** Drops messages that started more than `timeoutMs` ago; returns how many. */
  prune(nowMs: number, timeoutMs: number): number {
    let n = 0;
    for (const [seq, p] of this.partial) {
      if (nowMs - p.startedMs > timeoutMs) {
        this.partial.delete(seq);
        n++;
      }
    }
    return n;
  }

  get pending(): number {
    return this.partial.size;
  }
}
