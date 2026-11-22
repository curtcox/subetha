// LAN gossip (spec §11.5) over any node:dgram-shaped UDP module: node:dgram itself
// (./lan-node.ts), or react-native-udp on phones. Peers announce themselves with multicast
// beacons and gossip over a unicast socket.

import type { Envelope } from "../protocol/envelope.ts";
import type { GossipNode } from "./gossip.ts";
import { LanGossip, LAN_GROUP, LAN_PORT } from "./lan.ts";

export interface LanOptions {
  group?: string;
  /** Multicast port (all peers must agree). Default 47353. */
  port?: number;
  /** Local interface address for multicast (default: the OS's choice). */
  interfaceAddress?: string;
  beaconMs?: number;
  /** Multicast TTL; 1 keeps beacons on the local network. */
  ttl?: number;
  /** Our node id (16 hex digits). Default: random. */
  nodeId?: string;
}

export interface LanHandle {
  readonly nodeId: string;
  readonly unicastPort: number;
  peers(): number;
  resync(): Promise<void>;
  stop(): Promise<void>;
}

/** The parts of a node:dgram socket LAN gossip uses (react-native-udp has the same shape). */
export interface DgramSocketLike {
  bind(port: number, callback: () => void): unknown;
  address(): { port: number };
  send(msg: Uint8Array, offset: number, length: number, port: number, address: string, callback?: (err?: unknown) => void): void;
  on(event: "message", listener: (msg: Uint8Array, rinfo: { address: string; port: number }) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  off?(event: "error", listener: (err: Error) => void): unknown;
  removeListener?(event: "error", listener: (err: Error) => void): unknown;
  addMembership(group: string, iface?: string): void;
  setMulticastTTL?(ttl: number): void;
  setMulticastLoopback?(on: boolean): void;
  setMulticastInterface?(iface: string): void;
  close(callback?: () => void): void;
}

export interface DgramLike {
  createSocket(opts: { type: "udp4"; reuseAddr?: boolean; reusePort?: boolean }): DgramSocketLike;
}

const bind = (s: DgramSocketLike, port: number) =>
  new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.bind(port, () => {
      (s.off ?? s.removeListener)?.call(s, "error", reject);
      resolve();
    });
  });

/** Joins the LAN with the given UDP module: announces this node, finds peers, and gossips until stopped. */
export async function startLanWith(dgram: DgramLike, node: GossipNode, onMessage: (env: Envelope) => void, opts: LanOptions = {}): Promise<LanHandle> {
  const group = opts.group ?? LAN_GROUP;
  const port = opts.port ?? LAN_PORT;
  const uni = dgram.createSocket({ type: "udp4" });
  await bind(uni, 0);
  const unicastPort = uni.address().port;
  const lan = new LanGossip(node, {
    port: unicastPort,
    nodeId: opts.nodeId,
    onMessage,
    send: (host, p, d) => new Promise<void>((resolve) => uni.send(d, 0, d.length, p, host, () => resolve())),
  });
  uni.on("message", (msg, rinfo) => void lan.onDatagram(new Uint8Array(msg), rinfo.address, rinfo.port));

  const multi = dgram.createSocket({ type: "udp4", reuseAddr: true, reusePort: true });
  await bind(multi, port);
  multi.addMembership(group, opts.interfaceAddress);
  multi.setMulticastTTL?.(opts.ttl ?? 1);
  multi.setMulticastLoopback?.(true); // peers on the same host find each other too
  if (opts.interfaceAddress) multi.setMulticastInterface?.(opts.interfaceAddress);
  multi.on("message", (msg, rinfo) => void lan.onBeacon(new Uint8Array(msg), rinfo.address));

  const announce = () => {
    const b = lan.beacon();
    try {
      multi.send(b, 0, b.length, port, group);
    } catch {
      // no route yet (e.g. Wi-Fi just dropped); the next beacon retries
    }
  };
  announce();
  const timer = setInterval(announce, opts.beaconMs ?? 5000);
  (timer as { unref?: () => void }).unref?.();
  return {
    nodeId: lan.nodeId,
    unicastPort,
    peers: () => lan.peerCount,
    resync: () => lan.resync(),
    async stop() {
      clearInterval(timer);
      await Promise.all([new Promise<void>((r) => multi.close(() => r())), new Promise<void>((r) => uni.close(() => r()))]);
    },
  };
}
