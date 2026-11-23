// Runtime pricing helpers used by the relay. All money is integer micro-dollars (µ$) except
// rent SKUs, which accrue in nano-dollars and are settled to µ$ by the metering cron.
import type { PriceTable } from "./generate.ts";
export * from "./generate.ts";

export type SkuId = string;

/** Price of `qty` units of an action SKU, in whole µ$. Throws for unknown SKUs (unknown = rejected). */
export function actionPriceMicros(table: PriceTable, sku: SkuId, tier = "standard", qty = 1): number {
  const s = table.skus[sku];
  if (!s) throw new Error(`unknown sku: ${sku}`);
  const n = s.price_nanos[tier] ?? s.price_nanos.standard!;
  return Math.ceil((n * qty) / 1000);
}

/** Accrued rent in nano-dollars. */
export function rentNanos(table: PriceTable, sku: SkuId, units: number, tier = "standard"): number {
  const s = table.skus[sku];
  if (!s || s.charge !== "rent") throw new Error(`unknown rent sku: ${sku}`);
  return Math.ceil((s.price_nanos[tier] ?? s.price_nanos.standard!) * units);
}

/** Delivery SKU for a relay transport, or null for edge transports (free) and unknown ones. */
export function skuForTransport(table: PriceTable, transport: string): SkuId | null {
  for (const [id, s] of Object.entries(table.skus)) if (s.transports.includes(transport)) return id;
  return null;
}

/** Fee withheld from a top-up and the amount credited, in µ$. */
export function topupSplit(table: PriceTable, amountMicros: number): { feeMicros: number; creditMicros: number } {
  const { fee_percent, fee_fixed_usd_micros, min_usd_micros, max_usd_micros } = table.topup;
  if (amountMicros < min_usd_micros || amountMicros > max_usd_micros) throw new Error("top-up amount out of range");
  const feeMicros = Math.ceil((amountMicros * fee_percent) / 100) + fee_fixed_usd_micros;
  return { feeMicros, creditMicros: amountMicros - feeMicros };
}

export function tierFor(table: PriceTable, topupsLast12moMicros: number): string {
  let tier = table.tiers[0]!.id;
  for (const t of table.tiers) if (topupsLast12moMicros >= t.min_topups_usd * 1e6) tier = t.id;
  return tier;
}

/**
 * Price of one unit of a live-priced SKU (PLAN §8, rule 5), in whole µ$: the SKU's cost with
 * `component` replaced by today's provider price, marked up and floored exactly as the generator
 * does for static SKUs. Returns null when the provider price is unknown, or when the result would
 * not keep the minimum margin (unknown or unprofitable destinations are rejected).
 */
export function livePriceMicros(table: PriceTable, sku: SkuId, component: string, providerUsd: number, tier = "standard"): number | null {
  const s = table.skus[sku];
  if (!s || s.charge !== "action" || !(providerUsd > 0) || !Number.isFinite(providerUsd)) return null;
  const t = table.tiers.find((x) => x.id === tier) ?? table.tiers[0]!;
  const cost = s.cost_nanos - (s.components_nanos[component] ?? 0) + Math.ceil(Math.round(providerUsd * 1e12) / 1000);
  const p = Math.ceil((cost * (1 + s.markup * t.markup_factor) + s.floor_nanos) / 1000) * 1000;
  if (!(p > cost) || (p - cost) / p < table.min_margin) return null;
  return p / 1000;
}
