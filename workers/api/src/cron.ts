// Scheduled jobs (PLAN §7, §8): rent metering, freeze/cleanup, reconciliation, Twilio repricing.
import { rentNanos, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { audit, invalidateAccount } from "./accounts.ts";
import { accountStub } from "./durable/account.ts";
import type { Env } from "./types.ts";

const PRICES = prices as unknown as PriceTable;
const GRACE_DAYS = 30;
/** Twilio cost assumed by pricing/costs.yaml for one outbound US SMS segment (twilio + carrier fee). */
export const SMS_COST_ASSUMED_USD = 0.0083 + 0.003;
export const CIRCUIT_KEY = "circuit:telephony";

export async function runCron(cron: string, env: Env, now: number) {
  if (cron === "17 3 * * *") {
    await meterRent(env, now);
    await reconcile(env, now);
    await checkTwilioPrices(env);
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
      }
      continue;
    }
    if (!a.frozen_since) {
      // Freeze: paid endpoints stop receiving (unverify keeps the record so it can be re-verified).
      await env.DB.prepare("UPDATE accounts SET frozen_since = ? WHERE id = ?").bind(now, a.id).run();
      await audit(env, a.id, "cron", "account.frozen", { micros });
      await invalidateAccount(env, a.id);
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

/** Trips the telephony circuit if Twilio's US SMS price exceeds what our prices assume. */
export async function checkTwilioPrices(env: Env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;
  try {
    const r = await fetch("https://pricing.twilio.com/v2/Messaging/Countries/US", { headers: { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { outbound_sms_prices?: { prices?: { current_price?: string }[] }[] };
    const max = Math.max(0, ...(j.outbound_sms_prices ?? []).flatMap((c) => (c.prices ?? []).map((p) => Number(p.current_price ?? 0))));
    await env.CACHE.put("twilio:us:sms:max_usd", String(max));
    if (max === 0 || max > 0.0083 * 1.1) await env.CACHE.put(CIRCUIT_KEY, `open: twilio US SMS ${max} > assumed`, { expirationTtl: 2 * 86_400 });
    else await env.CACHE.delete(CIRCUIT_KEY);
  } catch (e) {
    console.error("twilio repricing failed", e);
  }
}
