// Delivery planning (PLAN §5): which transports each subscriber gets, in what order, at what cost.
import { EDGE_TRANSPORTS, type RouteMode, type Transport } from "@subetha/sdk/protocol";
import { actionPriceMicros, skuForTransport, type PriceTable } from "@subetha/pricing";
import { MMS_SKU } from "./delivery/units.ts";
import type { PlannedDelivery, QueuedSubscription, TopicPolicy } from "./model.ts";

export type LiveSubscriber = string | { id: string; transport?: "ws" | "sse" };

/** Typical end-to-end delivery latency (ms), used for sorting `fast` / `all` plans. */
const LATENCY_MS: Record<Transport, number> = {
  lan: 20, ws: 50, sse: 80, poll: 250, ble: 400, webpush: 700, apns: 800, fcm: 800,
  webhook: 900, slack: 1000, mcp: 1000, audio: 1500, qr: 2000, whatsapp: 2500,
  sms: 3000, voice: 15000, email: 20000, lxmf: 60000,
};

export interface PlanInput {
  liveSubscribers: LiveSubscriber[]; // connection ids (with optional ws/sse transport) matching the message filters
  queued: QueuedSubscription[];
  mode: RouteMode;
  priority: number;
  /** Transport restrictions; null allow = everything. Intersection is applied. */
  allowLists: (Transport[] | null | undefined)[];
  denyLists: (Transport[] | null | undefined)[];
  policy: TopicPolicy;
  maxCostMicros: number | null;
  /** Drop queued escalation steps scheduled at or after this many seconds (PLAN §4). */
  deadlineS?: number | null;
  prices: PriceTable;
  tier: string;
  nowMs: number;
  /** Message tags, for subscription tag filters. */
  tags?: string[];
  /** Billable units per transport (SMS segments, call minutes). Default 1. */
  units?: Partial<Record<Transport, number>>;
  /** Unit price (µ$) of SMS/voice to a country outside the US at this tier, or null if unpriced. */
  destPrice?: (transport: Transport, country: string) => number | null;
  /** The message carries an image for MMS: US SMS subscribers get one MMS (MMS_SKU) instead of segments. */
  mms?: boolean;
}

export interface Plan {
  deliveries: PlannedDelivery[];
  dropped: { subscriber: string; transport: Transport; reason: string }[];
  costMicros: number;
}

function minutesOfDay(nowMs: number, tz?: string): number {
  const d = new Date(nowMs);
  if (!tz || tz === "UTC") return d.getUTCHours() * 60 + d.getUTCMinutes();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function inQuietHours(q: TopicPolicy["quiet_hours"], nowMs: number): boolean {
  if (!q) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const now = minutesOfDay(nowMs, q.tz);
  const a = toMin(q.start), b = toMin(q.end);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

export function transportAllowed(t: Transport, allowLists: PlanInput["allowLists"], denyLists: PlanInput["denyLists"]): boolean {
  for (const a of allowLists) if (a && !a.includes(t)) return false;
  for (const d of denyLists) if (d && d.includes(t)) return false;
  return true;
}

export function planDeliveries(input: PlanInput): Plan {
  const deliveries: PlannedDelivery[] = [];
  const dropped: Plan["dropped"] = [];
  const price = (t: Transport) => {
    const sku = skuForTransport(input.prices, t);
    return { sku, cost: sku ? actionPriceMicros(input.prices, sku, input.tier, input.units?.[t] ?? 1) : 0 };
  };
  const allowLists = [...input.allowLists, input.policy.allow_transports];
  const denyLists = [...input.denyLists, input.policy.deny_transports];

  const liveIds = new Set<string>();
  for (const s of input.liveSubscribers) {
    const id = typeof s === "string" ? s : s.id;
    const t: Transport = typeof s === "string" ? "ws" : (s.transport ?? "ws");
    const why =
      !transportAllowed(t, allowLists, denyLists) ? "transport denied by policy" :
      (input.policy.min_priority?.[t] ?? 1) > input.priority ? "below minimum priority" :
      null;
    if (why) {
      dropped.push({ subscriber: id, transport: t, reason: why });
      continue;
    }
    const { sku, cost } = price(t);
    liveIds.add(id);
    deliveries.push({ subscriber: id, transport: t, sku, cost_micros: cost, after_s: 0 });
  }

  const quiet = inQuietHours(input.policy.quiet_hours, input.nowMs);
  for (const sub of input.queued) {
    const t = sub.transport;
    const minPrio = Math.max(sub.min_priority ?? 1, input.policy.min_priority?.[t] ?? 1);
    const why =
      !transportAllowed(t, allowLists, denyLists) ? "transport denied by policy" :
      input.mode === "cheap" && !EDGE_TRANSPORTS.includes(t) ? "route mode cheap" :
      quiet ? "quiet hours" :
      minPrio > input.priority ? "below minimum priority" :
      sub.filter?.priority?.length && !sub.filter.priority.includes(input.priority) ? "filtered" :
      sub.filter?.tags?.length && !sub.filter.tags.every((t) => input.tags?.includes(t)) ? "filtered" :
      null;
    if (why) {
      dropped.push({ subscriber: sub.id, transport: t, reason: why });
      continue;
    }
    const after = input.mode === "all" ? 0 : input.mode === "fast" ? Math.min(sub.after_s ?? 0, 5) : sub.after_s ?? 0;
    if (input.deadlineS != null && after >= input.deadlineS) {
      dropped.push({ subscriber: sub.id, transport: t, reason: "past deadline" });
      continue;
    }
    let { sku, cost } = price(t);
    if (sub.country) {
      const unit = input.destPrice?.(t, sub.country) ?? null;
      if (unit === null) {
        dropped.push({ subscriber: sub.id, transport: t, reason: "destination price unknown" });
        continue;
      }
      sku = `deliver_${t}_intl`;
      cost = unit * (input.units?.[t] ?? 1);
    } else if (t === "sms" && input.mms && input.prices.skus[MMS_SKU]) {
      sku = MMS_SKU;
      cost = actionPriceMicros(input.prices, MMS_SKU, input.tier);
    }
    deliveries.push({ subscriber: sub.id, transport: t, sku, cost_micros: cost, after_s: after });
  }

  // Sort deterministically by route mode: `any`/`cheap` cheapest-first; `fast`/`all` fastest-first.
  const cmp = (a: PlannedDelivery, b: PlannedDelivery) => {
    if (a.after_s !== b.after_s) return a.after_s - b.after_s;
    const la = LATENCY_MS[a.transport] ?? 1000;
    const lb = LATENCY_MS[b.transport] ?? 1000;
    if (input.mode === "fast" || input.mode === "all") {
      return la - lb || a.cost_micros - b.cost_micros || a.transport.localeCompare(b.transport);
    }
    return a.cost_micros - b.cost_micros || la - lb || a.transport.localeCompare(b.transport);
  };
  deliveries.sort(cmp);

  // Respect the message's max cost: drop the most expensive escalation steps first.
  const caps = [input.maxCostMicros, input.policy.max_cost_per_message_micros].filter((x): x is number => typeof x === "number");
  const cap = caps.length ? Math.min(...caps) : null;
  let total = deliveries.reduce((n, d) => n + d.cost_micros, 0);
  if (cap !== null && total > cap) {
    // Live deliveries are always made (they're broadcast to every allowed connection), so only
    // paid queued steps can be dropped to fit the cap.
    const order = deliveries.map((d, i) => ({ d, i })).filter(({ d }) => !liveIds.has(d.subscriber)).sort((a, b) => b.d.after_s - a.d.after_s || b.d.cost_micros - a.d.cost_micros);
    const remove = new Set<number>();
    for (const { d, i } of order) {
      if (total <= cap) break;
      remove.add(i);
      total -= d.cost_micros;
      dropped.push({ subscriber: d.subscriber, transport: d.transport, reason: "max cost" });
    }
    return { deliveries: deliveries.filter((_, i) => !remove.has(i)), dropped, costMicros: total };
  }
  return { deliveries, dropped, costMicros: total };
}
