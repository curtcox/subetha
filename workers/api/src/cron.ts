// Scheduled jobs (PLAN §7, §8, §14): rent metering, freeze/cleanup, reconciliation, Twilio
// repricing, and the nightly D1 backup.
import { livePriceMicros, rentNanos, tierFor, type PriceTable, type SkuPrice } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { audit, invalidateAccount, recomputeAccountTopups12mo } from "./accounts.ts";
import { deleteAccountAttachments } from "./attachments.ts";
import { backupDatabase } from "./backup.ts";
import { syncAccountEndpoints } from "./control.ts";
import { accountStub } from "./durable/account.ts";
import { sendAccountNotice, WARNING_DAYS_BEFORE } from "./notices.ts";
import { DEST_PRICES_KEY, INTL_COUNTRIES, type DestinationPrices } from "./delivery/destinations.ts";
import { emitMetric } from "./telemetry.ts";
import type { Env } from "./types.ts";

const PRICES = prices as unknown as PriceTable;
const GRACE_DAYS = 30;
export const CIRCUIT_KEY = "circuit:telephony";
/** Minimum daily Twilio spend (µ$) before the divergence breaker evaluates margin (avoids noise on tiny test traffic). */
export const DIVERGENCE_NOISE_MICROS = 250_000; // $0.25

export const accountCircuitKey = (accountId: string) => `circuit:telephony:acct:${accountId}`;

/** Returns the active telephony circuit-breaker reason (global or per-account), or null if open for business. */
export async function checkTelephonyCircuit(env: Env, accountId: string): Promise<string | null> {
  const [global, acct] = await Promise.all([env.CACHE.get(CIRCUIT_KEY), env.CACHE.get(accountCircuitKey(accountId))]);
  return global ?? acct;
}

/** Trips a per-account telephony circuit breaker (PLAN §8). */
export async function tripAccountTelephonyCircuit(env: Env, accountId: string, reason: string, ttlS = 30 * 86_400): Promise<void> {
  const value = `open: ${reason}`;
  await env.CACHE.put(accountCircuitKey(accountId), value, { expirationTtl: ttlS });
  await audit(env, accountId, "system", "circuit.telephony_tripped", { reason });
  emitMetric(env, { accountId, event: "circuit", transport: "sms", outcome: "tripped", detail: reason });
}

export async function runCron(cron: string, env: Env, now: number) {
  if (cron === "17 3 * * *") {
    await refreshVolumeTiers(env, now);
    await meterRent(env, now);
    await reconcile(env, now);
    await checkTwilioPrices(env);
    await checkProviderDivergence(env, now);
    await repriceDestinations(env, now);
    await deleteExpiredFiles(env, now);
    // Device codes live 10 minutes; approved ones are kept a day for the device's last poll.
    await env.DB.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now - 86_400_000).run();
    await env.DB.prepare("DELETE FROM verify_sends WHERE sent_at < ?").bind(now - 86_400_000).run();
    await backupDatabase(env, now);
  }
}

/** Recalculates rolling 12-month top-ups from stripe_payments so expired top-ups drop off volume tiers. */
export async function refreshVolumeTiers(env: Env, now: number) {
  const { results } = await env.DB.prepare("SELECT DISTINCT account_id FROM stripe_payments").all<{ account_id: string }>();
  for (const r of results) await recomputeAccountTopups12mo(env, r.account_id, now);
}

/** Daily rent for enrolled devices and verified endpoints, charged in arrears for one day. */
export async function meterRent(env: Env, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.email, a.frozen_since, a.topups_12mo_micros,
      (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices,
      (SELECT COUNT(*) FROM endpoints e WHERE e.account_id = a.id AND e.verified_at IS NOT NULL) AS endpoints
     FROM accounts a`).all<{ id: string; email: string | null; frozen_since: number | null; topups_12mo_micros: number; devices: number; endpoints: number }>();
  for (const a of results) {
    if (!a.devices && !a.endpoints) continue;
    const tier = tierFor(PRICES, a.topups_12mo_micros ?? 0);
    const nanos = rentNanos(PRICES, "device_day", a.devices, tier) + rentNanos(PRICES, "endpoint_day", a.endpoints, tier);
    const micros = Math.ceil(nanos / 1000);
    const r = await accountStub(env, a.id).charge(micros, `rent:${day}`, null, {}, true);
    if (r.ok) {
      emitMetric(env, { accountId: a.id, event: "rent", sku: "device_day", revenueMicros: micros, units: a.devices + a.endpoints });
      if (a.frozen_since) {
        await env.DB.prepare("UPDATE accounts SET frozen_since = NULL WHERE id = ?").bind(a.id).run();
        await invalidateAccount(env, a.id);
        await syncAccountEndpoints(env, a.id); // endpoints deliver again
      }
      continue;
    }
    if (!a.frozen_since) {
      // Freeze: the account's endpoints drop out of every topic's delivery plan until it pays
      // again (records are kept for the grace period).
      await env.DB.prepare("UPDATE accounts SET frozen_since = ? WHERE id = ?").bind(now, a.id).run();
      await audit(env, a.id, "cron", "account.frozen", { micros });
      await invalidateAccount(env, a.id);
      await syncAccountEndpoints(env, a.id);
      await sendAccountNotice(env, a, "frozen", now, GRACE_DAYS);
    } else if (now - a.frozen_since > GRACE_DAYS * 86_400_000) {
      await deleteAccountAttachments(env, a.id);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM subscriptions WHERE endpoint_id IN (SELECT id FROM endpoints WHERE account_id = ?)").bind(a.id),
        env.DB.prepare("DELETE FROM endpoints WHERE account_id = ?").bind(a.id),
        env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").bind(now, a.id),
        env.DB.prepare("UPDATE accounts SET frozen_since = NULL WHERE id = ?").bind(a.id),
      ]);
      await invalidateAccount(env, a.id);
      await audit(env, a.id, "cron", "account.resources_deleted", { after_days: GRACE_DAYS });
      await sendAccountNotice(env, a, "deleted", a.frozen_since, GRACE_DAYS);
    } else {
      // Still in the grace period: retry a freeze notice that failed, then warn a week ahead.
      await sendAccountNotice(env, a, "frozen", a.frozen_since, GRACE_DAYS);
      if (now - a.frozen_since >= (GRACE_DAYS - WARNING_DAYS_BEFORE) * 86_400_000) {
        await sendAccountNotice(env, a, "deletion_warning", a.frozen_since, GRACE_DAYS);
      }
    }
  }
}

/** Compares Stripe top-ups, refunds, and disputes recorded from webhooks with ledger entries journaled from AccountDOs. */
export async function reconcile(env: Env, now: number) {
  const since = now - 2 * 86_400_000;
  const cutoff = now - 3_600_000;
  const { results } = await env.DB.prepare(
    `SELECT s.account_id, SUM(s.amount_micros) AS stripe,
       (SELECT COUNT(*) FROM ledger_journal j WHERE j.account_id = s.account_id AND j.kind = 'topup' AND j.time >= ?) AS topups,
       (SELECT COALESCE(SUM(j.amount), 0) FROM ledger_journal j WHERE j.account_id = s.account_id AND j.kind = 'topup' AND j.time >= ?) AS credited
     FROM stripe_events s
     WHERE s.type IN ('checkout.session.completed', 'payment_intent.succeeded') AND s.account_id IS NOT NULL AND s.created_at >= ? AND s.created_at < ?
     GROUP BY s.account_id`)
    .bind(since, since, since, cutoff).all<{ account_id: string; stripe: number; topups: number; credited: number }>();
  for (const r of results) {
    if (r.topups === 0) {
      await audit(env, r.account_id, "cron", "reconcile.missing_topup", { stripe_micros: r.stripe });
    } else if (r.credited > r.stripe) {
      await audit(env, r.account_id, "cron", "reconcile.topup_overcredit", { stripe_micros: r.stripe, credited_micros: r.credited });
    }
  }
  const { results: adjEvents } = await env.DB.prepare(
    `SELECT s.account_id, SUM(s.amount_micros) AS stripe_deducted,
       (SELECT COUNT(*) FROM ledger_journal j WHERE j.account_id = s.account_id AND j.kind IN ('refund', 'adjust') AND j.time >= ?) AS adjustments
     FROM stripe_events s
     WHERE s.type IN ('charge.refunded', 'charge.dispute.created') AND s.account_id IS NOT NULL AND s.amount_micros > 0 AND s.created_at >= ? AND s.created_at < ?
     GROUP BY s.account_id`)
    .bind(since, since, cutoff).all<{ account_id: string; stripe_deducted: number; adjustments: number }>();
  for (const r of adjEvents) {
    if (r.adjustments === 0) {
      await audit(env, r.account_id, "cron", "reconcile.missing_adjustment", { stripe_deducted_micros: r.stripe_deducted });
    }
  }
}

/**
 * The most one provider unit (`component` of `sku`, e.g. Twilio's share of an SMS segment) may
 * cost before the SKU's cheapest tier falls below the minimum margin (PLAN §8, rules 2 and 5).
 */
export function providerCeilingUsd(sku: SkuPrice, component: string, minMargin = PRICES.min_margin): number {
  const cheapest = Math.min(...Object.values(sku.price_nanos));
  const others = sku.cost_nanos - (sku.components_nanos[component] ?? 0);
  return (cheapest * (1 - minMargin) - others) / 1e9;
}

/**
 * Pulls Twilio's live US prices for outbound SMS and voice and trips the telephony circuit (which
 * pauses SMS and voice deliveries) if either is unknown or above what our prices can absorb
 * without breaking the margin floor. Closes it again once both are back under.
 */
export async function checkTwilioPrices(env: Env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;
  const headers = { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` };
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`https://pricing.twilio.com/v2/${path}`, { headers });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  };
  const prices = (xs: { current_price?: string }[] | undefined) => (xs ?? []).map((p) => Number(p.current_price ?? 0)).filter((n) => Number.isFinite(n));
  try {
    const sms = await get<{ outbound_sms_prices?: { prices?: { current_price?: string }[] }[] }>("Messaging/Countries/US");
    const voice = await get<{ outbound_prefix_prices?: { current_price?: string }[] }>("Voice/Countries/US");
    const checks = [
      { name: "SMS", max: Math.max(0, ...(sms.outbound_sms_prices ?? []).flatMap((c) => prices(c.prices))), ceiling: providerCeilingUsd(PRICES.skus.deliver_sms_us!, "twilio") },
      { name: "voice", max: Math.max(0, ...prices(voice.outbound_prefix_prices)), ceiling: providerCeilingUsd(PRICES.skus.deliver_voice_us!, "twilio") },
    ];
    await env.CACHE.put("twilio:us:sms:max_usd", String(checks[0]!.max));
    await env.CACHE.put("twilio:us:voice:max_usd", String(checks[1]!.max));
    const bad = checks.filter((c) => c.max === 0 || c.max > c.ceiling);
    if (bad.length) {
      const why = bad.map((c) => (c.max === 0 ? `twilio US ${c.name} price unknown` : `twilio US ${c.name} ${c.max} > ${c.ceiling.toFixed(5)}`)).join("; ");
      await env.CACHE.put(CIRCUIT_KEY, `open: ${why}`, { expirationTtl: 2 * 86_400 });
    } else {
      const existing = await env.CACHE.get(CIRCUIT_KEY);
      if (existing && !existing.includes("provider spend divergence")) await env.CACHE.delete(CIRCUIT_KEY);
    }
  } catch (e) {
    // Leave the circuit as it was; an open one expires after two days without a successful check.
    console.error("twilio repricing failed", e);
  }
}

/**
 * Compares Twilio's reported spend for the prior UTC day against settled metered revenue in
 * ledger_journal (PLAN §8). If provider spend exceeds what our minimum margin allows, trips the
 * global telephony circuit breaker so SMS and voice stop until investigated.
 */
export async function checkProviderDivergence(env: Env, now: number): Promise<{ tripped: boolean; twilioMicros: number; revenueMicros: number } | null> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  const base = (env.TWILIO_API_BASE || "https://api.twilio.com").replace(/\/+$/, "");
  const headers = { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` };
  try {
    const r = await fetch(`${base}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Usage/Records/Yesterday.json`, { headers });
    if (!r.ok) throw new Error(`twilio usage HTTP ${r.status}`);
    const data = (await r.json()) as { usage_records?: { category?: string; price?: string | number }[] };
    const totalUsd = (data.usage_records ?? [])
      .filter((u) => u.category === "totalprice")
      .reduce((n, u) => n + Math.max(0, Number(u.price ?? 0)), 0)
      || (data.usage_records ?? [])
        .filter((u) => /^(sms|mms|calls|phonenumbers)/.test(u.category ?? ""))
        .reduce((n, u) => n + Math.max(0, Number(u.price ?? 0)), 0);
    const twilioMicros = Math.round(totalUsd * 1e6);

    const todayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const yestStart = todayStart - 86_400_000;
    // In ledger_journal: reserve is -amount and settle/release is +released, so SUM(-amount) is net charged.
    // Exclude non-telephony deliveries tagged with a non-telephony sku in meta so webhook/email/push revenue cannot mask Twilio losses.
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(-amount), 0) AS net
         FROM ledger_journal
        WHERE time >= ? AND time < ? AND kind IN ('reserve', 'settle')
          AND (ref LIKE 'dlv:%' OR ref LIKE 'verify:%' OR ref LIKE 'test:%' OR ref LIKE 'insms:%')
          AND (meta IS NULL OR meta NOT LIKE 'sku=%' OR meta LIKE 'sku=deliver_sms%' OR meta LIKE 'sku=deliver_mms%' OR meta LIKE 'sku=deliver_voice%' OR meta LIKE 'sku=deliver_whatsapp%')`,
    ).bind(yestStart, todayStart).first<{ net: number }>();
    const revenueMicros = Math.max(0, Number(row?.net ?? 0));

    const maxAllowedSpend = revenueMicros * (1 - PRICES.min_margin);
    if (twilioMicros > DIVERGENCE_NOISE_MICROS && twilioMicros > maxAllowedSpend) {
      const reason = `provider spend divergence (twilio $${(twilioMicros / 1e6).toFixed(2)} vs metered $${(revenueMicros / 1e6).toFixed(2)})`;
      await env.CACHE.put(CIRCUIT_KEY, `open: ${reason}`, { expirationTtl: 2 * 86_400 });
      emitMetric(env, { accountId: "system", event: "circuit", transport: "sms", outcome: "divergence", detail: reason, revenueMicros, providerCostMicros: twilioMicros });
      return { tripped: true, twilioMicros, revenueMicros };
    }
    return { tripped: false, twilioMicros, revenueMicros };
  } catch (e) {
    console.error("provider divergence check failed", e);
    return null;
  }
}

/** A provider price above this per SMS segment or call minute is treated as unpriced (toll-fraud guard). */
export const MAX_PROVIDER_USD = 0.5;

/**
 * Prices every opt-in country outside the US from Twilio's live prices (PLAN §8, rule 5): the
 * highest current outbound SMS price and voice prefix price for the country, marked up with the
 * `deliver_*_intl` SKUs. Countries Twilio can't price (or prices absurdly) are left out, and
 * left-out destinations are rejected. The table expires after three days without a refresh.
 */
export async function repriceDestinations(env: Env, now: number) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;
  const headers = { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` };
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const r = await fetch(`https://pricing.twilio.com/v2/${path}`, { headers });
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const nums = (xs: { current_price?: string }[] | undefined) => (xs ?? []).map((p) => Number(p.current_price ?? 0)).filter((n) => Number.isFinite(n) && n > 0);
  const perTier = (sku: string, usd: number) => {
    if (!(usd > 0 && usd <= MAX_PROVIDER_USD)) return undefined;
    const out: Record<string, number> = {};
    for (const t of PRICES.tiers) {
      const p = livePriceMicros(PRICES, sku, "twilio", usd, t.id);
      if (p === null) return undefined;
      out[t.id] = p;
    }
    return out;
  };
  const table: DestinationPrices = { updated_at: now, countries: {} };
  let reached = 0;
  for (const iso of Object.keys(INTL_COUNTRIES)) {
    const sms = await get<{ outbound_sms_prices?: { prices?: { current_price?: string }[] }[] }>(`Messaging/Countries/${iso}`);
    const voice = await get<{ outbound_prefix_prices?: { current_price?: string }[] }>(`Voice/Countries/${iso}`);
    if (sms || voice) reached++;
    const smsUsd = Math.max(0, ...(sms?.outbound_sms_prices ?? []).flatMap((c) => nums(c.prices)));
    const voiceUsd = Math.max(0, ...nums(voice?.outbound_prefix_prices));
    const entry = { sms: perTier("deliver_sms_intl", smsUsd), voice: perTier("deliver_voice_intl", voiceUsd), provider_usd: { sms: smsUsd || undefined, voice: voiceUsd || undefined } };
    if (entry.sms || entry.voice) table.countries[iso] = entry;
  }
  // Twilio unreachable: keep yesterday's table until it expires rather than replacing it with nothing.
  if (!reached) return;
  await env.CACHE.put(DEST_PRICES_KEY, JSON.stringify(table), { expirationTtl: 3 * 86_400 });
}

export async function deleteExpiredFiles(env: Env, now: number) {
  if (!env.FILES) return;
  for (let round = 0; round < 50; round++) {
    const { results } = await env.DB.prepare("SELECT id FROM files WHERE expires < ? LIMIT 1000").bind(Math.floor(now / 1000)).all<{ id: string }>();
    if (!results.length) return;
    await env.FILES.delete(results.map((r) => `att/${r.id}`));
    await env.DB.batch(results.map((r) => env.DB.prepare("DELETE FROM files WHERE id = ?").bind(r.id)));
    if (results.length < 1000) return;
  }
}
