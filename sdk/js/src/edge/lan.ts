// LAN discovery and gossip (spec §11.5), platform-neutral: the shim supplies UDP sockets
// (see ./lan-node.ts for Node). Peers announce themselves with multicast beacons and gossip
// over unicast UDP, each gossip message split into datagrams with the BLE chunk framing.

import type { Envelope } from "../protocol/envelope.ts";
import { chunk, Reassembler } from "./ble.ts";
import { encodeGossip, GossipNode, parseGossip } from "./gossip.ts";
import { utf8 } from "../protocol/encoding.ts";

export const LAN_GROUP = "239.255.83.69";
export const LAN_PORT = 47353;
/** Data bytes per datagram (keeps datagrams under typical 1280-byte path MTUs with headers). */
export const LAN_DATAGRAM_DATA = 1200;
/** The chunk "MTU" whose capacity is LAN_DATAGRAM_DATA (chunk() subtracts 9). */
export const LAN_CHUNK_MTU = LAN_DATAGRAM_DATA + 9;
export const LAN_PEER_TIMEOUT_MS = 30_000;

export interface LanBeacon { subetha: "lan/1"; node: string; port: number }

export function encodeBeacon(b: Omit<LanBeacon, "subetha">): Uint8Array {
  return utf8.encode(JSON.stringify({ subetha: "lan/1", node: b.node, port: b.port }));
}

export function parseBeacon(bytes: Uint8Array): LanBeacon | null {
  try {
    const b = JSON.parse(utf8.decode(bytes)) as LanBeacon;
    if (b?.subetha === "lan/1" && typeof b.node === "string" && /^[0-9a-f]{16}$/.test(b.node) &&
      Number.isInteger(b.port) && b.port > 0 && b.port < 65536) return b;
  } catch {
    // not ours
  }
  return null;
}

/** A random 64-bit node id. Not a secret: Math.random is the fallback where crypto is missing (Hermes). */
export const randomNodeId = () => {
  const b = new Uint8Array(8);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

interface Peer { node: string; host: string; port: number; seen: number; reasm: Reassembler }

export interface LanGossipOptions {
  /** Our unicast port (announced in beacons). */
  port: number;
  nodeId?: string;
  send: (host: string, port: number, datagram: Uint8Array) => void | Promise<void>;
  onMessage: (env: Envelope) => void;
  now?: () => number;
}

/** LAN gossip state: known peers, per-peer reassembly, and the gossip exchange. */
export class LanGossip {
  readonly nodeId: string;
  private peers = new Map<string, Peer>();
  private seq = 0;
  private readonly opts: LanGossipOptions;
  private readonly node: GossipNode;
  private readonly now: () => number;

  constructor(node: GossipNode, opts: LanGossipOptions) {
    this.node = node;
    this.opts = opts;
    this.nodeId = opts.nodeId ?? randomNodeId();
    this.now = opts.now ?? Date.now;
  }

  /** The beacon to multicast every few seconds. */
  beacon(): Uint8Array {
    return encodeBeacon({ node: this.nodeId, port: this.opts.port });
  }

  get peerCount(): number {
    return this.peers.size;
  }

  private async sendTo(p: Peer, bytes: Uint8Array): Promise<void> {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    for (const d of chunk(seq, bytes, LAN_CHUNK_MTU)) await this.opts.send(p.host, p.port, d);
  }

  private expire(): void {
    const t = this.now();
    for (const [k, p] of this.peers) if (t - p.seen > LAN_PEER_TIMEOUT_MS) this.peers.delete(k);
  }

  /** Handles a multicast datagram. A newly seen peer gets our summary. */
  async onBeacon(bytes: Uint8Array, fromHost: string): Promise<void> {
    const b = parseBeacon(bytes);
    if (!b || b.node === this.nodeId) return;
    this.expire();
    const key = `${fromHost}:${b.port}`;
    const known = this.peers.get(key);
    if (known) {
      known.seen = this.now();
      return;
    }
    const p: Peer = { node: b.node, host: fromHost, port: b.port, seen: this.now(), reasm: new Reassembler() };
    this.peers.set(key, p);
    await this.sendTo(p, encodeGossip(this.node.summary()));
  }

  /** Handles a unicast datagram from a peer. Unknown senders are answered too (beacons can be lost). */
  async onDatagram(bytes: Uint8Array, fromHost: string, fromPort: number): Promise<void> {
    const key = `${fromHost}:${fromPort}`;
    let p = this.peers.get(key);
    const isNew = !p;
    if (!p) {
      p = { node: "", host: fromHost, port: fromPort, seen: this.now(), reasm: new Reassembler() };
      this.peers.set(key, p);
    }
    let msgBytes: Uint8Array | null;
    try {
      msgBytes = p.reasm.push(bytes, this.now());
    } catch {
      return;
    }
    p.reasm.prune(this.now(), 10_000);
    if (!msgBytes) return;
    const msg = parseGossip(msgBytes);
    if (!msg) return;
    const h = await this.node.handle(msg);
    h.delivered.forEach(this.opts.onMessage);
    for (const r of h.replies) await this.sendTo(p, encodeGossip(r));
    // A peer we hadn't heard a beacon from yet: offer what we hold right away.
    if (isNew) await this.sendTo(p, encodeGossip(this.node.summary()));
    // Something new arrived: tell every peer (they may want it), including this one.
    if (msg.type === "deliver" && h.dropped.length < msg.envelopes.length) await this.resync();
  }

  /** Sends our summary to every known peer (after publishing). */
  async resync(): Promise<void> {
    this.expire();
    const s = encodeGossip(this.node.summary());
    for (const p of this.peers.values()) await this.sendTo(p, s);
  }
}
