// Price generation (PLAN §8). Pure functions: costs in, price table out, invariants checked.

export interface CostsFile {
  version: number;
  policy: { markup: number; min_margin: number; currency: string };
  tiers: { id: string; min_topups_usd: number; markup_factor: number }[];
  topup: { min_usd: number; max_usd: number; fee_percent: number; fee_fixed_usd: number; stripe_worst_percent: number; stripe_worst_fixed_usd: number };
  skus: Record<string, {
    description: string;
    unit: string;
    charge: "action" | "rent";
    transports?: string[];
    markup?: number;
    components: Record<string, number>;
    floor_usd: number;
  }>;
}

export interface FixedCostsFile {
  monthly: Record<string, number>;
  assumptions: { avg_topup_usd: number; deliveries_per_publish: number };
}

export interface SkuPrice {
  description: string;
  unit: string;
  charge: "action" | "rent";
  transports: string[];
  cost_nanos: number;
  /** Price in nano-dollars, per tier. Action SKUs are whole micro-dollars (multiples of 1000). */
  price_nanos: Record<string, number>;
  margin: Record<string, number>;
}

export interface PriceTable {
  version: number;
  generated_from: string;
  currency: string;
  min_margin: number;
  tiers: { id: string; min_topups_usd: number }[];
  topup: { min_usd_micros: number; max_usd_micros: number; fee_percent: number; fee_fixed_usd_micros: number };
  skus: Record<string, SkuPrice>;
}

export class PricingInvariantError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super("pricing invariants violated:\n  " + violations.join("\n  "));
    this.violations = violations;
  }
}

/** Convert USD to integer nano-dollars, rounding up so costs are never under-stated. */
export const usdToNanosCeil = (usd: number) => Math.ceil(Math.round(usd * 1e9 * 1000) / 1000);

export function generatePrices(costs: CostsFile, source = "pricing/costs.yaml"): PriceTable {
  const violations: string[] = [];
  const skus: Record<string, SkuPrice> = {};
  const { min_margin } = costs.policy;
  if (!(min_margin > 0 && min_margin < 1)) violations.push(`policy.min_margin must be in (0,1), got ${min_margin}`);

  for (const [id, sku] of Object.entries(costs.skus)) {
    const costUsd = Object.values(sku.components).reduce((a, b) => a + b, 0);
    const cost = usdToNanosCeil(costUsd);
    if (cost <= 0 && sku.charge === "action") violations.push(`${id}: cost must be positive`);
    if (!(sku.floor_usd > 0)) violations.push(`${id}: floor_usd must be positive`);
    for (const [k, v] of Object.entries(sku.components)) if (!(v >= 0)) violations.push(`${id}.${k}: negative component`);
    const markup = sku.markup ?? costs.policy.markup;
    const price_nanos: Record<string, number> = {};
    const margin: Record<string, number> = {};
    for (const tier of costs.tiers) {
      let p = cost * (1 + markup * tier.markup_factor) + usdToNanosCeil(sku.floor_usd);
      p = sku.charge === "action" ? Math.ceil(p / 1000) * 1000 : Math.ceil(p);
      price_nanos[tier.id] = p;
      const m = (p - cost) / p;
      margin[tier.id] = Math.round(m * 10000) / 10000;
      if (!(p > cost)) violations.push(`${id}@${tier.id}: price ${p} ≤ cost ${cost}`);
      if (m < min_margin) violations.push(`${id}@${tier.id}: margin ${(m * 100).toFixed(2)}% < ${(min_margin * 100).toFixed(0)}%`);
    }
    // Tiers must be monotone: a bigger tier never pays more.
    const ps = costs.tiers.map((t) => price_nanos[t.id]!);
    for (let i = 1; i < ps.length; i++) if (ps[i]! > ps[i - 1]!) violations.push(`${id}: tier ${costs.tiers[i]!.id} is more expensive than ${costs.tiers[i - 1]!.id}`);
    skus[id] = { description: sku.description, unit: sku.unit, charge: sku.charge, transports: sku.transports ?? [], cost_nanos: cost, price_nanos, margin };
  }

  // Every transport that can be metered maps to exactly one delivery SKU.
  const seen = new Map<string, string>();
  for (const [id, s] of Object.entries(skus)) for (const t of s.transports) {
    if (seen.has(t)) violations.push(`transport ${t} is mapped by both ${seen.get(t)} and ${id}`);
    seen.set(t, id);
  }

  // Top-up fee must cover Stripe's worst case at every amount in range.
  const t = costs.topup;
  for (const amount of [t.min_usd, (t.min_usd + t.max_usd) / 2, t.max_usd]) {
    const fee = (amount * t.fee_percent) / 100 + t.fee_fixed_usd;
    const stripe = (amount * t.stripe_worst_percent) / 100 + t.stripe_worst_fixed_usd;
    if (fee < stripe) violations.push(`topup fee $${fee.toFixed(4)} < Stripe worst case $${stripe.toFixed(4)} at $${amount}`);
  }
  if (t.fee_percent < t.stripe_worst_percent) violations.push("topup.fee_percent must be ≥ stripe_worst_percent");
  if (t.fee_fixed_usd < t.stripe_worst_fixed_usd) violations.push("topup.fee_fixed_usd must be ≥ stripe_worst_fixed_usd");

  // Tiers sorted, starting at 0.
  if (costs.tiers[0]?.min_topups_usd !== 0) violations.push("first tier must start at 0");
  for (let i = 1; i < costs.tiers.length; i++) if (costs.tiers[i]!.min_topups_usd <= costs.tiers[i - 1]!.min_topups_usd) violations.push("tiers must be sorted by min_topups_usd");

  if (violations.length) throw new PricingInvariantError(violations);
  return {
    version: costs.version,
    generated_from: source,
    currency: costs.policy.currency,
    min_margin,
    tiers: costs.tiers.map(({ id, min_topups_usd }) => ({ id, min_topups_usd })),
    topup: {
      min_usd_micros: Math.round(t.min_usd * 1e6),
      max_usd_micros: Math.round(t.max_usd * 1e6),
      fee_percent: t.fee_percent,
      fee_fixed_usd_micros: Math.round(t.fee_fixed_usd * 1e6),
    },
    skus,
  };
}

const fmtUsd = (nanos: number) => {
  const usd = nanos / 1e9;
  return usd >= 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(9).replace(/0+$/, "")}`;
};

export function renderReport(table: PriceTable, fixed: FixedCostsFile): string {
  const tiers = table.tiers.map((t) => t.id);
  const lines: string[] = [];
  lines.push("# SubEtha pricing invariant report", "");
  lines.push(`Generated from \`${table.generated_from}\`. Every SKU at every tier must have a margin ≥ ${(table.min_margin * 100).toFixed(0)}% — this report only exists if that held.`, "");
  lines.push(`| SKU | Unit | Cost | ${tiers.map((t) => `Price (${t})`).join(" | ")} | ${tiers.map((t) => `Margin (${t})`).join(" | ")} |`);
  lines.push(`|---|---|---:|${tiers.map(() => "---:").join("|")}|${tiers.map(() => "---:").join("|")}|`);
  for (const [id, s] of Object.entries(table.skus)) {
    lines.push(`| \`${id}\` | ${s.unit} | ${fmtUsd(s.cost_nanos)} | ${tiers.map((t) => fmtUsd(s.price_nanos[t]!)).join(" | ")} | ${tiers.map((t) => `${(s.margin[t]! * 100).toFixed(1)}%`).join(" | ")} |`);
  }
  lines.push("", "Edge transports (BLE, audio, QR, LAN) never touch the relay and are free.", "");
  const monthly = Object.values(fixed.monthly).reduce((a, b) => a + b, 0);
  const t = table.topup;
  const avg = fixed.assumptions.avg_topup_usd;
  const feeOnAvg = (avg * t.fee_percent) / 100 + t.fee_fixed_usd_micros / 1e6;
  const stripeOnAvg = avg * 0.029 + 0.3;
  const contribution = feeOnAvg - stripeOnAvg;
  lines.push("## Fixed costs and break-even", "");
  lines.push(`| Item | USD / month |`, `|---|---:|`);
  for (const [k, v] of Object.entries(fixed.monthly)) lines.push(`| ${k} | $${v.toFixed(2)} |`);
  lines.push(`| **Total** | **$${monthly.toFixed(2)}** |`, "");
  const pub = table.skus.publish!, live = table.skus.deliver_live!;
  const unitMargin = (pub.price_nanos.standard! - pub.cost_nanos + fixed.assumptions.deliveries_per_publish * (live.price_nanos.standard! - live.cost_nanos)) / 1e9;
  lines.push(`- Top-up fee: ${t.fee_percent}% + $${(t.fee_fixed_usd_micros / 1e6).toFixed(2)}. On an average $${avg} top-up (domestic card) it contributes $${contribution.toFixed(3)} to fixed costs.`);
  lines.push(`- Break-even on top-up fees alone: **${Math.ceil(monthly / contribution)} top-ups / month**.`);
  lines.push(`- Margin per published message with ${fixed.assumptions.deliveries_per_publish} live deliveries: $${unitMargin.toFixed(7)}; break-even on messages alone: **${Math.ceil(monthly / unitMargin).toLocaleString("en-US")} messages / month**.`);
  lines.push("- Profit = Σ(volume × unit margin) − fixed costs, so it only rises with volume.", "");
  return lines.join("\n");
}
