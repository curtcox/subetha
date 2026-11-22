// Node shim for LAN gossip (spec §11.5): UDP multicast beacons + unicast gossip with node:dgram.
// Not part of the browser bundle (browsers have no UDP).
import { createSocket, type Socket } from "node:dgram";
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
}

export interface LanHandle {
  readonly nodeId: string;
  readonly unicastPort: number;
  peers(): number;
  resync(): Promise<void>;
  stop(): Promise<void>;
}

const bind = (s: Socket, port: number, address?: string) =>
  new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.bind({ port, address, exclusive: false }, () => {
      s.off("error", reject);
      resolve();
    });
  });

/** Joins the LAN: announces this node, finds peers, and gossips with them until stopped. */
export async function startLan(node: GossipNode, onMessage: (env: Envelope) => void, opts: LanOptions = {}): Promise<LanHandle> {
  const group = opts.group ?? LAN_GROUP;
  const port = opts.port ?? LAN_PORT;
  const uni = createSocket({ type: "udp4" });
  await bind(uni, 0);
  const unicastPort = uni.address().port;
  const lan = new LanGossip(node, {
    port: unicastPort,
    onMessage,
    send: (host, p, d) => new Promise<void>((resolve) => uni.send(d, p, host, () => resolve())),
  });
  uni.on("message", (msg, rinfo) => void lan.onDatagram(new Uint8Array(msg), rinfo.address, rinfo.port));

  const multi = createSocket({ type: "udp4", reuseAddr: true });
  await bind(multi, port);
  multi.addMembership(group, opts.interfaceAddress);
  multi.setMulticastTTL(opts.ttl ?? 1);
  multi.setMulticastLoopback(true); // peers on the same host find each other too
  if (opts.interfaceAddress) multi.setMulticastInterface(opts.interfaceAddress);
  multi.on("message", (msg, rinfo) => void lan.onBeacon(new Uint8Array(msg), rinfo.address));

  const announce = () => multi.send(lan.beacon(), port, group);
  announce();
  const timer = setInterval(announce, opts.beaconMs ?? 5000);
  timer.unref?.();
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
