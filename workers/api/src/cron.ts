// Scheduled jobs (PLAN §7, §8, §14): rent metering, freeze/cleanup, reconciliation, Twilio
// repricing, and the nightly D1 backup.
import { rentNanos, type PriceTable, type SkuPrice } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { audit, invalidateAccount } from "./accounts.ts";
import { backupDatabase } from "./backup.ts";
import { syncAccountEndpoints } from "./control.ts";
import { accountStub } from "./durable/account.ts";
import type { Env } from "./types.ts";

const PRICES = prices as unknown as PriceTable;
const GRACE_DAYS = 30;
export const CIRCUIT_KEY = "circuit:telephony";

export async function runCron(cron: string, env: Env, now: number) {
  if (cron === "17 3 * * *") {
    await meterRent(env, now);
    await reconcile(env, now);
    await checkTwilioPrices(env);
    await deleteExpiredFiles(env, now);
    // Device codes live 10 minutes; approved ones are kept a day for the device's last poll.
    await env.DB.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now - 86_400_000).run();
    await env.DB.prepare("DELETE FROM verify_sends WHERE sent_at < ?").bind(now - 86_400_000).run();
    await backupDatabase(env, now);
  }
}

/** Daily rent for enrolled devices and verified endpoints, charged in arrears for one day. */
export async function meterRent(env: Env, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.frozen_since,
      (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices,
      (SELECT COUNT(*) FROM endpoints e WHERE e.account_id = a.id AND e.verified_at IS NOT NULL) AS endpoints
     FROM accounts a`).all<{ id: string; frozen_since: number | null; devices: number; endpoints: number }>();
  for (const a of results) {
    if (!a.devices && !a.endpoints) continue;
    const nanos = rentNanos(PRICES, "device_day", a.devices) + rentNanos(PRICES, "endpoint_day", a.endpoints);
    const micros = Math.ceil(nanos / 1000);
    const r = await accountStub(env, a.id).charge(micros, `rent:${day}`, null, {}, true);
    if (r.ok) {
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
    } else if (now - a.frozen_since > GRACE_DAYS * 86_400_000) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM subscriptions WHERE endpoint_id IN (SELECT id FROM endpoints WHERE account_id = ?)").bind(a.id),
        env.DB.prepare("DELETE FROM endpoints WHERE account_id = ?").bind(a.id),
        env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").bind(now, a.id),
      ]);
      await audit(env, a.id, "cron", "account.resources_deleted", { after_days: GRACE_DAYS });
    }
  }
}

/** Compares Stripe top-ups recorded from webhooks with ledger top-ups journaled from AccountDOs. */
export async function reconcile(env: Env, now: number) {
  const since = now - 2 * 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT s.account_id, SUM(s.amount_micros) AS stripe,
       (SELECT COUNT(*) FROM ledger_journal j WHERE j.account_id = s.account_id AND j.kind = 'topup' AND j.time >= ?) AS topups
     FROM stripe_events s WHERE s.type = 'checkout.session.completed' AND s.created_at >= ? AND s.created_at < ? GROUP BY s.account_id`)
    .bind(since, since, now - 3_600_000).all<{ account_id: string; stripe: number; topups: number }>();
  for (const r of results) if (r.topups === 0) await audit(env, r.account_id, "cron", "reconcile.missing_topup", { stripe_micros: r.stripe });
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
      await env.CACHE.delete(CIRCUIT_KEY);
    }
  } catch (e) {
    // Leave the circuit as it was; an open one expires after two days without a successful check.
    console.error("twilio repricing failed", e);
  }
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
