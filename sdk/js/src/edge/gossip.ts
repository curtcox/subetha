// Edge gossip for BLE and LAN (spec §11.4), a pure state machine matching
// sdk/core/src/edge/gossip.rs. Peers exchange summary → request → deliver; hops are
// decremented on forward, ids are deduped, expired and uninteresting messages are dropped.

import type { Envelope } from "../protocol/envelope.ts";
import { verifyEnvelope } from "../protocol/sign.ts";

export const MAX_GOSSIP_HOPS = 16;

export type GossipMessage =
  | { type: "summary"; topics: Record<string, string[]> }
  | { type: "request"; ids: string[] }
  | { type: "deliver"; envelopes: Envelope[] };

export type DropReason = "no_id" | "not_interested" | "duplicate" | "expired" | "bad_hops" | "bad_signature" | "unsigned";

export interface GossipConfig {
  /** Ids advertised per topic in a summary (most recent first). */
  summaryLimit: number;
  /** Messages kept per topic for forwarding. */
  storeLimit: number;
  /** Drop messages without a signature. */
  requireSignatures: boolean;
  /** Dedupe LRU size. */
  dedupeCapacity: number;
  /**
   * Checks a signed envelope. Default: `verifyEnvelope` (WebCrypto Ed25519). Runtimes without
   * WebCrypto Ed25519 (React Native's Hermes) pass the Rust core's verifier instead.
   */
  verify: (env: Envelope) => boolean | Promise<boolean>;
}

export interface Handled {
  replies: GossipMessage[];
  delivered: Envelope[];
  dropped: { id: string | undefined; reason: DropReason }[];
}

const DEFAULTS: GossipConfig = { summaryLimit: 64, storeLimit: 256, requireSignatures: false, dedupeCapacity: 10_000, verify: (e) => verifyEnvelope(e) };
const nowSecs = () => Math.floor(Date.now() / 1000);
const hopsOf = (e: Envelope) => e.hops ?? 0;
const expired = (e: Envelope, now: number) => e.expires !== undefined && e.expires < now;

/** Parses and shape-checks a gossip message from a peer (JSON bytes or text). */
export function parseGossip(data: Uint8Array | string): GossipMessage | null {
  try {
    const m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as GossipMessage;
    if (m?.type === "summary" && typeof m.topics === "object" && m.topics !== null &&
      Object.values(m.topics).every((ids) => Array.isArray(ids) && ids.every((i) => typeof i === "string"))) return m;
    if (m?.type === "request" && Array.isArray(m.ids) && m.ids.every((i) => typeof i === "string")) return m;
    if (m?.type === "deliver" && Array.isArray(m.envelopes) &&
      m.envelopes.every((e) => typeof e === "object" && e !== null && typeof e.topic === "string")) return m;
  } catch {
    // fall through
  }
  return null;
}

export function encodeGossip(m: GossipMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m));
}

export class GossipNode {
  readonly config: GossipConfig;
  private subscriptions = new Set<string>();
  private relayable = new Set<string>();
  private store = new Map<string, Envelope>();
  /** Per topic, ids in arrival order (oldest first). */
  private recent = new Map<string, string[]>();
  /** Dedupe LRU: id → expires (insertion order = recency). */
  private seen = new Map<string, number | undefined>();

  constructor(config: Partial<GossipConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  subscribe(topic: string): void {
    this.subscriptions.add(topic);
  }

  unsubscribe(topic: string): void {
    this.subscriptions.delete(topic);
  }

  /** Relay `topic` for others without delivering it locally. */
  setRelayable(topic: string, relay: boolean): void {
    if (relay) this.relayable.add(topic);
    else this.relayable.delete(topic);
  }

  interested(topic: string): boolean {
    return this.subscriptions.has(topic) || this.relayable.has(topic);
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id.toUpperCase());
  }

  get(id: string): Envelope | undefined {
    return this.store.get(id.toUpperCase());
  }

  get stored(): number {
    return this.store.size;
  }

  private markSeen(id: string, expires: number | undefined): boolean {
    const key = id.toUpperCase();
    if (this.seen.has(key)) {
      this.seen.delete(key);
      this.seen.set(key, expires);
      return false;
    }
    this.seen.set(key, expires);
    while (this.seen.size > this.config.dedupeCapacity) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** Originates a message (signed/encrypted as needed; needs an id). False if duplicate/invalid. */
  publish(env: Envelope, now = nowSecs()): boolean {
    if (!env.id || expired(env, now) || !this.markSeen(env.id, env.expires)) return false;
    this.remember(env.id, env);
    return true;
  }

  private remember(id: string, env: Envelope): void {
    if (hopsOf(env) <= 0) return;
    const key = id.toUpperCase();
    let q = this.recent.get(env.topic);
    if (!q) this.recent.set(env.topic, (q = []));
    q.push(key);
    while (q.length > this.config.storeLimit) this.store.delete(q.shift()!);
    this.store.set(key, env);
  }

  private forwardable(env: Envelope, now: number): boolean {
    return hopsOf(env) > 0 && !expired(env, now) && this.interested(env.topic);
  }

  /** The summary to send to a peer we just met (or periodically). */
  summary(now = nowSecs()): GossipMessage {
    const topics: Record<string, string[]> = {};
    for (const topic of [...this.recent.keys()].sort()) {
      const list: string[] = [];
      const ids = this.recent.get(topic)!;
      for (let i = ids.length - 1; i >= 0 && list.length < this.config.summaryLimit; i--) {
        const e = this.store.get(ids[i]!);
        if (e && this.forwardable(e, now)) list.push(ids[i]!);
      }
      if (list.length) topics[topic] = list;
    }
    return { type: "summary", topics };
  }

  /** Handles one message from a peer. */
  async handle(msg: GossipMessage, now = nowSecs()): Promise<Handled> {
    const out: Handled = { replies: [], delivered: [], dropped: [] };
    if (msg.type === "summary") {
      const ids = new Set<string>();
      for (const [topic, list] of Object.entries(msg.topics)) {
        if (!this.interested(topic)) continue;
        for (const id of list) if (!this.hasSeen(id)) ids.add(id);
      }
      if (ids.size) out.replies.push({ type: "request", ids: [...ids].sort() });
    } else if (msg.type === "request") {
      const envelopes: Envelope[] = [];
      for (const id of msg.ids) {
        const e = this.store.get(id.toUpperCase());
        if (e && this.forwardable(e, now)) envelopes.push({ ...e, hops: hopsOf(e) - 1 });
      }
      if (envelopes.length) out.replies.push({ type: "deliver", envelopes });
    } else {
      for (const env of msg.envelopes) {
        const why = await this.check(env, now);
        if (why) {
          out.dropped.push({ id: env.id, reason: why });
          continue;
        }
        if (this.subscriptions.has(env.topic)) out.delivered.push(env);
        this.remember(env.id!, env);
      }
    }
    return out;
  }

  private async check(env: Envelope, now: number): Promise<DropReason | null> {
    if (!env.id) return "no_id";
    if (!this.interested(env.topic)) return "not_interested";
    const hops = hopsOf(env);
    if (!Number.isInteger(hops) || hops < 0 || hops > MAX_GOSSIP_HOPS) return "bad_hops";
    if (expired(env, now)) return "expired";
    if (this.hasSeen(env.id)) return "duplicate";
    if (env.sig !== undefined) {
      let ok = false;
      try {
        ok = await this.config.verify(env);
      } catch {
        // a verifier that throws counts as a failed check
      }
      if (!ok) return "bad_signature";
    } else if (this.config.requireSignatures) {
      return "unsigned";
    }
    if (!this.markSeen(env.id, env.expires)) return "duplicate"; // raced with a concurrent handle()
    return null;
  }

  /** Drops expired messages from the forwarding store and dedupe set. */
  prune(now = nowSecs()): void {
    for (const [id, e] of this.store) if (expired(e, now)) this.store.delete(id);
    for (const [topic, q] of this.recent) {
      const kept = q.filter((id) => this.store.has(id));
      if (kept.length) this.recent.set(topic, kept);
      else this.recent.delete(topic);
    }
    for (const [id, exp] of this.seen) if (exp !== undefined && exp < now) this.seen.delete(id);
  }
}

/**
 * Runs one gossip session over a bidirectional message link (BLE, LAN, WebSocket…): sends our
 * summary, answers whatever arrives, and hands new messages to `onMessage`. Returns a function
 * that feeds incoming bytes; call `resync()` to re-send the summary (e.g. after publishing).
 */
export function gossipSession(
  node: GossipNode,
  send: (bytes: Uint8Array) => void | Promise<void>,
  onMessage: (env: Envelope) => void,
): { receive: (bytes: Uint8Array) => Promise<void>; resync: () => Promise<void> } {
  const resync = async () => {
    await send(encodeGossip(node.summary()));
  };
  const receive = async (bytes: Uint8Array) => {
    const msg = parseGossip(bytes);
    if (!msg) return;
    const h = await node.handle(msg);
    h.delivered.forEach(onMessage);
    for (const r of h.replies) await send(encodeGossip(r));
    // We hold something new: advertise it (the peer may also hold more for us).
    if (msg.type === "deliver" && h.dropped.length < msg.envelopes.length) await resync();
  };
  return { receive, resync };
}
