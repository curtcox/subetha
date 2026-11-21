// Delivery planning (PLAN §5): which transports each subscriber gets, in what order, at what cost.
import { EDGE_TRANSPORTS, type RouteMode, type Transport } from "@subetha/sdk/protocol";
import { actionPriceMicros, skuForTransport, type PriceTable } from "@subetha/pricing";
import type { PlannedDelivery, QueuedSubscription, TopicPolicy } from "./types.ts";

export interface PlanInput {
  liveSubscribers: string[]; // connection ids matching the message filters
  queued: QueuedSubscription[];
  mode: RouteMode;
  priority: number;
  /** Transport restrictions; null allow = everything. Intersection is applied. */
  allowLists: (Transport[] | null | undefined)[];
  denyLists: (Transport[] | null | undefined)[];
  policy: TopicPolicy;
  maxCostMicros: number | null;
  prices: PriceTable;
  tier: string;
  nowMs: number;
  /** Billable units per transport (SMS segments, call minutes). Default 1. */
  units?: Partial<Record<Transport, number>>;
}

export interface Plan {
  deliveries: PlannedDelivery[];
  dropped: { subscriber: string; transport: Transport; reason: string }[];
  costMicros: number;
}

export function inQuietHours(q: TopicPolicy["quiet_hours"], nowMs: number): boolean {
  if (!q) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const d = new Date(nowMs);
  const now = d.getUTCHours() * 60 + d.getUTCMinutes();
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

  for (const id of input.liveSubscribers) {
    // Live connections are the cheapest relay path; the specific transport (ws/sse/poll) is fixed by the connection.
    const { sku, cost } = price("ws");
    deliveries.push({ subscriber: id, transport: "ws", sku, cost_micros: cost, after_s: 0 });
  }

  const quiet = inQuietHours(input.policy.quiet_hours, input.nowMs);
  for (const sub of input.queued) {
    const t = sub.transport;
    const why =
      !transportAllowed(t, allowLists, denyLists) ? "transport denied by policy" :
      input.mode === "cheap" && !EDGE_TRANSPORTS.includes(t) ? "route mode cheap" :
      quiet ? "quiet hours" :
      (sub.min_priority ?? input.policy.min_priority?.[t] ?? 1) > input.priority ? "below minimum priority" :
      sub.filter?.priority && !sub.filter.priority.includes(input.priority) ? "filtered" :
      null;
    if (why) {
      dropped.push({ subscriber: sub.id, transport: t, reason: why });
      continue;
    }
    const { sku, cost } = price(t);
    const after = input.mode === "all" ? 0 : input.mode === "fast" ? Math.min(sub.after_s ?? 0, 5) : sub.after_s ?? 0;
    deliveries.push({ subscriber: sub.id, transport: t, sku, cost_micros: cost, after_s: after });
  }

  // Respect the message's max cost: drop the most expensive escalation steps first.
  const caps = [input.maxCostMicros, input.policy.max_cost_per_message_micros].filter((x): x is number => typeof x === "number");
  const cap = caps.length ? Math.min(...caps) : null;
  let total = deliveries.reduce((n, d) => n + d.cost_micros, 0);
  if (cap !== null && total > cap) {
    const order = deliveries.map((d, i) => ({ d, i })).sort((a, b) => b.d.after_s - a.d.after_s || b.d.cost_micros - a.d.cost_micros);
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
