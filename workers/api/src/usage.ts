// Spend by category and day, from the account's own ledger (PLAN §11 usage charts). Every charge
// carries a ref whose prefix says what it was for, and a reservation and its settlement (or a
// lease and its return) share the ref, so a ref's net is exactly what it cost. Each closed ref
// is counted on the day it started; open ones (in-flight deliveries, leases topics still hold)
// are reported as pending.

export const USAGE_CATEGORIES = ["publish", "deliveries", "live", "rent", "other"] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

export const USAGE_LABELS: Record<UsageCategory, string> = {
  publish: "Publishing",
  deliveries: "Paid deliveries",
  live: "Live delivery & storage",
  rent: "Device & endpoint rent",
  other: "API requests & other",
};

/** What a ledger ref was for, by its prefix (see the charge/reserve/lease call sites). */
export function categorize(ref: string): UsageCategory | null {
  const p = ref.slice(0, ref.indexOf(":"));
  switch (p) {
    case "pub": return "publish";
    case "dlv": return "deliveries";
    case "lease": return "live";
    case "rent": return "rent";
    case "topup": case "refund": case "dispute": case "adjust": case "recharge": return null; // money in/out, not usage
    default: return "other"; // dry, dup, dl, verify, inmail, insms, …
  }
}

/** The topic a live-delivery lease was for (`lease:<topic>:<ulid>`). */
export const leaseTopic = (ref: string) => (ref.startsWith("lease:") ? ref.slice(6, ref.lastIndexOf(":")) : null);

export type RefRow = { ref: string; start: number; net: number; closed: number; meta?: string | null };

/** Infers the SKU identifier from a ledger ref + optional `sku=...` metadata tag. */
export function skuOf(ref: string, meta?: string | null): string {
  const m = meta ? /(?:^|\s)sku=([a-z0-9_]+)/.exec(meta) : null;
  if (m) return m[1]!;
  const p = ref.slice(0, ref.indexOf(":"));
  switch (p) {
    case "pub": return "publish";
    case "lease": return "deliver_live";
    case "rent": return "device_day";
    case "inmail": return "inbound_email";
    case "insms": return "inbound_sms_us";
    case "dlv": return "deliver_other";
    case "verify": return "verify_endpoint";
    case "test": return "test_delivery";
    case "dry": case "dup": case "idem": case "keys": case "dl": return "api_request";
    default: return "other";
  }
}

export interface Usage {
  since: number;
  days: { day: string; micros: Record<UsageCategory, number>; total: number }[];
  totals: Record<UsageCategory, number>;
  total_micros: number;
  pending_micros: number;
  live_by_topic: { topic: string; micros: number }[];
  by_sku: { sku: string; micros: number }[];
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const zero = () => Object.fromEntries(USAGE_CATEGORIES.map((c) => [c, 0])) as Record<UsageCategory, number>;

/** Aggregates per-ref rows (net = sum of signed ledger amounts) into `days` UTC days ending today. */
export function aggregateUsage(rows: RefRow[], nowMs: number, days: number): Usage {
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const since = today - (days - 1) * 86_400_000;
  const byDay = new Map<string, Record<UsageCategory, number>>();
  for (let i = 0; i < days; i++) byDay.set(dayOf(since + i * 86_400_000), zero());
  const totals = zero();
  const topics = new Map<string, number>();
  const skus = new Map<string, number>();
  let pending = 0;
  for (const r of rows) {
    if (r.start < since) continue;
    const cat = categorize(r.ref);
    if (!cat) continue;
    const spent = -r.net;
    if (!r.closed) { pending += Math.max(0, spent); continue; }
    if (spent <= 0) continue;
    byDay.get(dayOf(r.start))![cat] += spent;
    totals[cat] += spent;
    const sku = skuOf(r.ref, r.meta);
    skus.set(sku, (skus.get(sku) ?? 0) + spent);
    const t = leaseTopic(r.ref);
    if (t) topics.set(t, (topics.get(t) ?? 0) + spent);
  }
  return {
    since,
    days: [...byDay].map(([day, micros]) => ({ day, micros, total: Object.values(micros).reduce((a, b) => a + b, 0) })),
    totals,
    total_micros: Object.values(totals).reduce((a, b) => a + b, 0),
    pending_micros: pending,
    live_by_topic: [...topics].map(([topic, micros]) => ({ topic, micros })).sort((a, b) => b.micros - a.micros).slice(0, 10),
    by_sku: [...skus].map(([sku, micros]) => ({ sku, micros })).sort((a, b) => b.micros - a.micros),
  };
}
