// Client-side delivery plans and policy intersection (PLAN §5, mirrors sdk/core/src/routing.rs).
import { EDGE_TRANSPORTS, TRANSPORTS, type Envelope, type Route, type RouteMode, type Transport } from "./protocol/index.ts";

export interface TransportEstimate {
  transport: Transport;
  costUsdMicros: number;
  latencyMs: number;
}

export interface Policy {
  allow?: Transport[] | null;
  deny?: Transport[];
  maxCostUsdMicros?: number | null;
}

export interface DeliveryPlan {
  mode: RouteMode;
  dispatch: "sequential" | "parallel";
  steps: TransportEstimate[];
  worstCaseCostUsdMicros: number;
}

export function isFreeTransport(est: TransportEstimate): boolean {
  return EDGE_TRANSPORTS.includes(est.transport) || est.costUsdMicros === 0;
}

export function policyFromRoute(route?: Route): Policy {
  if (!route) return {};
  return {
    allow: route.allow ?? null,
    deny: route.deny ?? [],
    maxCostUsdMicros: route.max_cost_usd_micros ?? null,
  };
}

export function intersectPolicies(layers: Policy[]): Policy {
  let allow: Transport[] | null = null;
  const deny = new Set<Transport>();
  let maxCost: number | null = null;
  for (const p of layers) {
    if (p.allow != null) {
      const next = new Set(p.allow);
      allow = allow === null ? [...next] : allow.filter((t) => next.has(t));
    }
    for (const d of p.deny ?? []) deny.add(d);
    if (p.maxCostUsdMicros != null) {
      maxCost = maxCost === null ? p.maxCostUsdMicros : Math.min(maxCost, p.maxCostUsdMicros);
    }
  }
  return {
    allow,
    deny: [...deny],
    maxCostUsdMicros: maxCost,
  };
}

export function policyPermits(policy: Policy, t: Transport): boolean {
  if (policy.deny?.includes(t)) return false;
  if (policy.allow != null && !policy.allow.includes(t)) return false;
  return true;
}

const SPEC_INDEX = new Map<Transport, number>(TRANSPORTS.map((t, i) => [t, i]));
const specRank = (t: Transport) => SPEC_INDEX.get(t) ?? 999;

export function planDelivery(mode: RouteMode, policy: Policy, candidates: TransportEstimate[]): DeliveryPlan {
  const seen = new Set<Transport>();
  let steps = candidates.filter((c) => {
    if (seen.has(c.transport)) return false;
    seen.add(c.transport);
    if (!policyPermits(policy, c.transport)) return false;
    if (mode === "cheap" && !isFreeTransport(c)) return false;
    return true;
  });

  const byCost = (a: TransportEstimate, b: TransportEstimate) =>
    a.costUsdMicros - b.costUsdMicros || a.latencyMs - b.latencyMs || specRank(a.transport) - specRank(b.transport);
  const byLatency = (a: TransportEstimate, b: TransportEstimate) =>
    a.latencyMs - b.latencyMs || a.costUsdMicros - b.costUsdMicros || specRank(a.transport) - specRank(b.transport);

  steps.sort(mode === "fast" ? byLatency : byCost);

  let total = 0;
  steps = steps.filter((s) => {
    const next = total + s.costUsdMicros;
    if (policy.maxCostUsdMicros != null && next > policy.maxCostUsdMicros) return false;
    total = next;
    return true;
  });

  if (mode === "all") steps.sort(byLatency);
  return {
    mode,
    dispatch: mode === "all" ? "parallel" : "sequential",
    steps,
    worstCaseCostUsdMicros: total,
  };
}

export function planForEnvelope(env: Envelope, layers: Policy[], candidates: TransportEstimate[]): DeliveryPlan {
  const combined = intersectPolicies([...layers, policyFromRoute(env.route)]);
  const mode: RouteMode = env.route?.mode ?? "any";
  return planDelivery(mode, combined, candidates);
}
