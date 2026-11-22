// Edge ↔ relay bridge (PLAN §3 "a phone with BLE and internet is a gateway for nearby offline
// devices"). Relay messages on the bridged topics go into the gateway's gossip node, so nearby
// edge peers pick them up; messages that arrive over edge links go up to the relay unchanged.
// Uplinked publishes are billed to the gateway's token like any other publish.

import type { SubEtha, SubscribeOptions, Subscription } from "../client.ts";
import type { Envelope } from "../protocol/envelope.ts";
import type { GossipNode } from "./gossip.ts";

export interface EdgeBridgeOptions {
  topics: string[];
  /** Hops given to relay messages that carry none (how far they spread over edge links). Default 1. */
  hops?: number;
  /** Relay → edge. Default true. */
  downlink?: boolean;
  /** Edge → relay. Default true. */
  uplink?: boolean;
  /** Where the downlink subscription starts (e.g. "10m"). Default: new messages only. */
  since?: string;
  /** Called after a relay message enters the node; resync your links here. */
  onDownlink?: (env: Envelope) => void;
  /** Downlink transport (see SubscribeOptions.transport). */
  transport?: SubscribeOptions["transport"];
  onOpen?: () => void;
  onError?: (e: Error) => void;
}

export interface EdgeBridge {
  /**
   * Forward a message that arrived over an edge link: call it from your links' onMessage.
   * Resolves true if it was published.
   */
  uplink(env: Envelope): Promise<boolean>;
  close(): void;
}

export function bridgeEdge(client: SubEtha, node: GossipNode, opts: EdgeBridgeOptions): EdgeBridge {
  const topics = new Set(opts.topics);
  // Subscribed (not just relayable), so edge messages on these topics reach the app's
  // onMessage, which calls uplink().
  for (const t of topics) node.subscribe(t);
  const uplinked = new Set<string>();
  let sub: Subscription | null = null;
  if (opts.downlink !== false) {
    sub = client.subscribe([...topics], (env) => {
      const { event: _event, ...e } = env;
      if (!(typeof e.hops === "number" && e.hops > 0)) e.hops = opts.hops ?? 1;
      if (e.id && node.publish(e)) opts.onDownlink?.(e);
    }, { raw: true, since: opts.since, transport: opts.transport, onOpen: opts.onOpen, onError: opts.onError });
  }
  return {
    async uplink(env) {
      if (opts.uplink === false || !topics.has(env.topic) || !env.id || uplinked.has(env.id.toUpperCase())) return false;
      uplinked.add(env.id.toUpperCase());
      if (uplinked.size > 10_000) uplinked.delete(uplinked.values().next().value as string);
      try {
        await client.publishEnvelope(env);
        return true;
      } catch (e) {
        uplinked.delete(env.id.toUpperCase());
        opts.onError?.(e as Error);
        return false;
      }
    },
    close() {
      sub?.close();
    },
  };
}
