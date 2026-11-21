// Pure logic behind the site's built-in tools (PLAN §10): the pricing calculator and the offline
// route simulator. Both reuse the relay's own code (price table, planner, telephony units), so
// what the site shows is what the relay charges. The live route simulator is the console's dry
// run (X-Dry-Run: 1), which runs this same planner against the real topic.
import { TRANSPORTS, type RouteMode, type Transport } from "@subetha/sdk/protocol";
import { actionPriceMicros, rentNanos, skuForTransport, tierFor, type PriceTable } from "@subetha/pricing";
import pricesJson from "@subetha/pricing/prices.json";
import { planDeliveries, type Plan } from "../../../workers/api/src/routing.ts";
import type { QueuedSubscription, TopicPolicy } from "../../../workers/api/src/model.ts";
import { smsBody, smsSegments, voiceMinutes, renderText } from "../../../workers/api/src/delivery/units.ts";

export const PRICES = pricesJson as unknown as PriceTable;

/** Mirrors workers/api/src/durable/topic.ts. */
export const DEFAULT_RETENTION_S = 12 * 3600;
export const MAX_RETENTION_S = 30 * 86400;
/** Billing month used by the calculator (rent accrues per day). */
export const DAYS_PER_MONTH = 30;

/** Relay transports that have a delivery price (edge transports are free and never reach the relay). */
export const RELAY_TRANSPORTS = TRANSPORTS.filter((t) => skuForTransport(PRICES, t) !== null) as Transport[];

export interface Line {
  label: string;
  sku: string;
  quantity: number;
  unit: string;
  micros: number;
}

// ------------------------------------------------------------------ pricing calculator

export interface CalcInput {
  /** Top-ups in the last 12 months (USD): picks the price tier. */
  topupsUsd: number;
  messagesPerMonth: number;
  /** Topic retention in seconds (default 12 h, max 30 days). */
  retentionS?: number;
  /** A typical message; sets SMS segments. */
  sample?: { title?: string; message?: string };
  /** Average deliveries per message, by transport (e.g. { ws: 2, sms: 0.05 } for an occasional SMS escalation). */
  deliveries: Partial<Record<Transport, number>>;
  attachmentsPerMonth?: number;
  attachmentAvgMb?: number;
  /** Always-on live connections (each is billed per connection-hour while open). */
  connections?: number;
  devices?: number;
  /** Verified endpoints (emails, phones, webhooks, push subscriptions, …). */
  endpoints?: number;
  /** Other metered API requests (polls, dry runs, downloads). */
  apiRequestsPerMonth?: number;
  inboundEmailsPerMonth?: number;
  inboundSmsSegmentsPerMonth?: number;
}

export interface CalcResult {
  tier: string;
  lines: Line[];
  totalMicros: number;
  /** Cost of one message (publish + retention + its average deliveries), µ$. */
  perMessageMicros: number;
  smsSegments: number;
  /** Smallest top-up (USD, whole cents) whose credit after fees covers one month. */
  topupUsd: number;
  topupFeeUsd: number;
  /** The month needs more than the largest single top-up (split it, or use auto-recharge). */
  topupOverMax: boolean;
}

export function calculate(input: CalcInput, prices: PriceTable = PRICES): CalcResult {
  const tier = tierFor(prices, Math.max(0, input.topupsUsd) * 1e6);
  const n = Math.max(0, input.messagesPerMonth);
  const retentionS = Math.min(Math.max(0, input.retentionS ?? DEFAULT_RETENTION_S), MAX_RETENTION_S);
  const lines: Line[] = [];
  const add = (label: string, id: string, quantity: number, micros: number, unit = prices.skus[id]?.unit ?? "") => {
    if (quantity > 0 && micros > 0) lines.push({ label, sku: id, quantity, unit, micros });
  };

  // Per message, exactly as TopicDO.publish computes it (each message is rounded up separately).
  const publish = actionPriceMicros(prices, "publish", tier);
  const retention = Math.ceil(rentNanos(prices, "retention_message_day", retentionS / 86400, tier) / 1000);
  const segments = smsSegments(smsBody({ title: input.sample?.title, message: input.sample?.message ?? "" }));
  const units: Partial<Record<Transport, number>> = { sms: segments, voice: voiceMinutes(renderText(input.sample ?? {}, 1500)) };
  add("Publish", "publish", n, n * publish);
  add(`Retention (${+(retentionS / 3600).toFixed(2)} h per message)`, "retention_message_day", n, n * retention, "message");
  let perMessage = publish + retention;
  for (const t of RELAY_TRANSPORTS) {
    const count = Math.max(0, input.deliveries[t] ?? 0);
    if (!count) continue;
    const id = skuForTransport(prices, t)!;
    const each = actionPriceMicros(prices, id, tier, units[t] ?? 1);
    perMessage += count * each;
    const per = t === "sms" ? ` (${segments} segment${segments === 1 ? "" : "s"})` : t === "voice" ? ` (reserved for ${units.voice} min)` : "";
    add(`Deliver via ${t}${per}`, id, n * count, Math.ceil(n * count * each));
  }

  const att = Math.max(0, input.attachmentsPerMonth ?? 0);
  if (att) {
    const mbDays = Math.max(0, input.attachmentAvgMb ?? 0) * (retentionS / 86400);
    add("Attachment uploads", "attachment_upload", att, att * actionPriceMicros(prices, "attachment_upload", tier));
    add("Attachment storage", "attachment_mb_day", att, att * Math.ceil(rentNanos(prices, "attachment_mb_day", mbDays, tier) / 1000), "upload");
  }
  const hours = Math.max(0, input.connections ?? 0) * DAYS_PER_MONTH * 24;
  add("Live connections", "connection_hour", hours, Math.ceil(rentNanos(prices, "connection_hour", hours, tier) / 1000));
  // Device and endpoint rent is metered daily by the cron at the standard tier.
  const devices = Math.max(0, input.devices ?? 0), endpoints = Math.max(0, input.endpoints ?? 0);
  if (devices || endpoints) {
    const daily = Math.ceil((rentNanos(prices, "device_day", devices) + rentNanos(prices, "endpoint_day", endpoints)) / 1000);
    const dShare = devices ? rentNanos(prices, "device_day", devices) : 0;
    const eShare = endpoints ? rentNanos(prices, "endpoint_day", endpoints) : 0;
    const month = daily * DAYS_PER_MONTH;
    const dMicros = Math.round((month * dShare) / (dShare + eShare));
    add("Enrolled devices", "device_day", devices * DAYS_PER_MONTH, dMicros);
    add("Verified endpoints", "endpoint_day", endpoints * DAYS_PER_MONTH, month - dMicros);
  }
  const api = Math.max(0, input.apiRequestsPerMonth ?? 0);
  add("API requests", "api_request", api, api * actionPriceMicros(prices, "api_request", tier));
  const inMail = Math.max(0, input.inboundEmailsPerMonth ?? 0);
  add("Inbound email", "inbound_email", inMail, inMail * actionPriceMicros(prices, "inbound_email", tier));
  const inSms = Math.max(0, input.inboundSmsSegmentsPerMonth ?? 0);
  add("Inbound SMS", "inbound_sms_us", inSms, inSms * actionPriceMicros(prices, "inbound_sms_us", tier));

  const totalMicros = lines.reduce((s, l) => s + l.micros, 0);
  const topup = topupFor(totalMicros, prices);
  return { tier, lines, totalMicros, perMessageMicros: Math.ceil(perMessage), smsSegments: segments, topupUsd: topup.amountMicros / 1e6, topupFeeUsd: topup.feeMicros / 1e6, topupOverMax: topup.overMax };
}

/**
 * The smallest top-up (whole cents, at least the minimum) whose credit after the top-up fee
 * covers `creditMicros`. Inverse of topupSplit in @subetha/pricing.
 */
export function topupFor(creditMicros: number, prices: PriceTable = PRICES): { amountMicros: number; feeMicros: number; overMax: boolean } {
  const { fee_percent, fee_fixed_usd_micros, min_usd_micros, max_usd_micros } = prices.topup;
  const fee = (a: number) => Math.ceil((a * fee_percent) / 100) + fee_fixed_usd_micros;
  const cent = 10_000;
  let a = Math.max(min_usd_micros, Math.ceil((creditMicros + fee_fixed_usd_micros) / (1 - fee_percent / 100) / cent) * cent);
  while (a - fee(a) < creditMicros) a += cent;
  while (a - cent >= min_usd_micros && a - cent - fee(a - cent) >= creditMicros) a -= cent;
  return { amountMicros: a, feeMicros: fee(a), overMax: a > max_usd_micros };
}

// ------------------------------------------------------------------ route simulator

export interface SimSubscription {
  transport: Transport;
  after_s?: number;
  min_priority?: number;
  filter?: { priority?: number[]; tags?: string[] };
}

export interface SimInput {
  tier?: string;
  mode: RouteMode;
  priority: number;
  title?: string;
  message: string;
  tags?: string[];
  /** Open WebSocket/SSE connections matching the message. */
  live: number;
  subscriptions: SimSubscription[];
  policy?: TopicPolicy;
  /** X-Allow / X-Deny on the message, and the publishing token's transport allow-list. */
  allow?: Transport[];
  deny?: Transport[];
  tokenTransports?: Transport[];
  maxCostUsd?: number;
  nowMs?: number;
}

export interface SimStep {
  transport: Transport;
  subscriber: string;
  after_s: number;
  cost_micros: number;
}

export interface SimResult {
  plan: Plan;
  steps: SimStep[];
  publishMicros: number;
  retentionMicros: number;
  /** What the relay reserves (and the dry run reports): publish + every planned step + retention. */
  worstCaseMicros: number;
  /** If the message is acked before any escalation step runs (route modes any/fast/cheap). */
  ackedMicros: number;
  smsSegments: number;
}

export function simulate(input: SimInput, prices: PriceTable = PRICES): SimResult {
  const tier = input.tier ?? "standard";
  const policy = input.policy ?? {};
  const nowMs = input.nowMs ?? Date.now();
  const env = { title: input.title, message: input.message };
  const segments = smsSegments(smsBody(env));
  const queued: QueuedSubscription[] = input.subscriptions.map((s, i) => ({
    id: `sub_${i + 1}_${s.transport}`,
    transport: s.transport,
    endpoint: `ep_${i + 1}`,
    after_s: s.after_s ?? 0,
    min_priority: s.min_priority,
    filter: s.filter,
  }));
  const plan = planDeliveries({
    liveSubscribers: Array.from({ length: Math.max(0, input.live) }, (_, i) => `live_${i + 1}`),
    queued,
    mode: input.mode,
    priority: input.priority,
    allowLists: [input.allow?.length ? input.allow : null, input.tokenTransports?.length ? input.tokenTransports : null],
    denyLists: [input.deny?.length ? input.deny : null],
    policy,
    maxCostMicros: input.maxCostUsd !== undefined && input.maxCostUsd !== null && !Number.isNaN(input.maxCostUsd) ? Math.round(input.maxCostUsd * 1e6) : null,
    prices,
    tier,
    nowMs,
    tags: input.tags ?? [],
    units: { sms: segments, voice: voiceMinutes(renderText(env, 1500)) },
  });
  const publishMicros = actionPriceMicros(prices, "publish", tier);
  const retentionS = Math.min(policy.retention_s ?? DEFAULT_RETENTION_S, MAX_RETENTION_S);
  const retentionMicros = Math.ceil(rentNanos(prices, "retention_message_day", retentionS / 86400, tier) / 1000);
  const steps = plan.deliveries.map((d) => ({ transport: d.transport, subscriber: d.subscriber, after_s: d.after_s, cost_micros: d.cost_micros })).sort((a, b) => a.after_s - b.after_s);
  const immediate = plan.deliveries.filter((d) => d.after_s === 0).reduce((s, d) => s + d.cost_micros, 0);
  const worstCaseMicros = publishMicros + plan.costMicros + retentionMicros;
  const ackedMicros = input.mode === "all" ? worstCaseMicros : publishMicros + immediate + retentionMicros;
  return { plan, steps, publishMicros, retentionMicros, worstCaseMicros, ackedMicros, smsSegments: segments };
}

// ------------------------------------------------------------------ formatting

export function usd(micros: number): string {
  if (micros === 0) return "$0";
  const d = micros / 1e6;
  if (d >= 1) return `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (d >= 0.01) return `$${d.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${d.toFixed(6).replace(/0+$/, "")}`;
}
