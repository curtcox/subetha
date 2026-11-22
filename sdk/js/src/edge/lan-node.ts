// Node shim for LAN gossip (spec §11.5): UDP multicast beacons + unicast gossip with node:dgram.
// Not part of the browser bundle (browsers have no UDP). Other runtimes pass their own UDP
// module to startLanWith (./lan-socket.ts).
import * as dgram from "node:dgram";
import type { Envelope } from "../protocol/envelope.ts";
import type { GossipNode } from "./gossip.ts";
import { startLanWith, type DgramLike, type LanHandle, type LanOptions } from "./lan-socket.ts";

export type { LanHandle, LanOptions } from "./lan-socket.ts";

/** Joins the LAN: announces this node, finds peers, and gossips with them until stopped. */
export function startLan(node: GossipNode, onMessage: (env: Envelope) => void, opts: LanOptions = {}): Promise<LanHandle> {
  // Node's reusePort raises on platforms without SO_REUSEPORT; reuseAddr is enough here.
  const udp: DgramLike = {
    createSocket: ({ type, reuseAddr }) => dgram.createSocket({ type, reuseAddr }) as unknown as ReturnType<DgramLike["createSocket"]>,
  };
  return startLanWith(udp, node, onMessage, opts);
}
