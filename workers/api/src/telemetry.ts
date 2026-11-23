// Usage metering and cost telemetry via Cloudflare Analytics Engine (PLAN §7).
// Zero-throw: telemetry must never fail a publish, delivery, or webhook.
import type { PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import type { Env } from "./types.ts";

const PRICES = prices as unknown as PriceTable;

export interface MetricEvent {
  /** Primary index: account id (or "system" / "anonymous"). */
  accountId: string;
  /** Event category: publish | delivery | inbound_email | inbound_sms | rent | topup | dispute | refund | circuit. */
  event: string;
  transport?: string;
  sku?: string | null;
  outcome?: string;
  detail?: string;
  /** Metered revenue charged to the account (µ$). */
  revenueMicros?: number;
  /** Estimated marginal provider cost (µ$). */
  providerCostMicros?: number;
  units?: number;
  latencyMs?: number;
}

/** Marginal cost (µ$) for `units` of `sku` from costs.yaml, rounded up. */
export function estimatedCostMicros(sku: string | null | undefined, units = 1): number {
  if (!sku) return 0;
  const s = PRICES.skus[sku];
  if (!s) return 0;
  return Math.ceil((s.cost_nanos * Math.max(0, units)) / 1000);
}

/** Writes one data point to Analytics Engine if the binding is configured. */
export function emitMetric(env: Env, e: MetricEvent): void {
  if (!env.ANALYTICS) return;
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [e.accountId.slice(0, 96)],
      blobs: [
        e.event,
        e.transport ?? "",
        e.sku ?? "",
        e.outcome ?? "ok",
        (e.detail ?? "").slice(0, 128),
      ],
      doubles: [
        e.revenueMicros ?? 0,
        e.providerCostMicros ?? 0,
        e.units ?? 1,
        e.latencyMs ?? 0,
      ],
    });
  } catch {
    /* telemetry is best-effort */
  }
}
