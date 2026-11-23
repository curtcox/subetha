import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { actionPriceMicros, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { refreshVolumeTiers } from "../src/cron.ts";
import { signStripePayload } from "../src/stripe.ts";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;
const PRICES = prices as unknown as PriceTable;

async function stripeEvent(evt: Record<string, unknown>) {
  const payload = JSON.stringify(evt);
  const sig = await signStripePayload(payload, "whsec_test");
  return SELF.fetch(`${BASE}/v1/hooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": sig },
    body: payload,
  });
}

describe("rolling 12-month volume discount tiers", () => {
  it("propagates tier upgrades to existing and auto-created topics, and downgrades on refund or 12-month expiry", async () => {
    const a = await bootstrap("tieracct", 10);
    // Create an existing topic while on standard tier.
    expect((await SELF.fetch(`${BASE}/v1/topics/@tieracct/existing`, {
      method: "PUT",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ policy: {} }),
    })).status).toBe(201);

    const stdPub = actionPriceMicros(PRICES, "publish", "standard");
    const bulkPub = actionPriceMicros(PRICES, "publish", "bulk");
    const stdLxmf = actionPriceMicros(PRICES, "deliver_lxmf", "standard");
    const bulkLxmf = actionPriceMicros(PRICES, "deliver_lxmf", "bulk");
    expect(bulkLxmf).toBeLessThan(stdLxmf);

    // Subscribe an lxmf endpoint so delivery tier pricing difference is clearly visible.
    const epRes = await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ kind: "lxmf", address: "ab".repeat(16) }),
    });
    const ep = (await epRes.json()) as { id: string };
    await SELF.fetch(`${BASE}/v1/subscriptions`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ topic: "@tieracct/existing", endpoint_id: ep.id }),
    });

    // Dry-run before top-up uses standard tier.
    const dryStd = (await (await publish("@tieracct/existing", "hi", auth(a.token, { "x-dry-run": "1" }))).json()) as { plan: { cost_micros: number }[] };
    expect(dryStd.plan[0]!.cost_micros).toBe(stdLxmf);

    // Top up $500 via Stripe checkout -> crosses into `bulk` tier.
    const rTopup = await stripeEvent({
      id: "evt_tier_bulk_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_tier_1", payment_intent: "pi_tier_1", payment_status: "paid", amount_total: 50000, metadata: { account_id: a.account_id } } },
    });
    expect(rTopup.status).toBe(200);

    const acct1 = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { tier: string };
    expect(acct1.tier).toBe("bulk");

    // Existing topic now plans deliveries at `bulk` tier!
    const dryBulk = (await (await publish("@tieracct/existing", "hi", auth(a.token, { "x-dry-run": "1" }))).json()) as { plan: { cost_micros: number }[] };
    expect(dryBulk.plan[0]!.cost_micros).toBe(bulkLxmf);

    // Auto-created topic on publish also inherits `bulk` tier immediately.
    const autoPub = await publish("@tieracct/autocreated", "hello", auth(a.token));
    expect(autoPub.status).toBe(200);
    expect(Number(autoPub.headers.get("x-cost-micros"))).toBe(bulkPub);
    expect(bulkPub).toBeLessThanOrEqual(stdPub);

    // Partial refund of $100 drops 12-month net top-ups to $400 (< $500) -> downgrades back to standard!
    const rRefund = await stripeEvent({
      id: "evt_tier_refund_1",
      type: "charge.refunded",
      data: { object: { payment_intent: "pi_tier_1", amount_refunded: 10000 } },
    });
    expect(rRefund.status).toBe(200);

    const acct2 = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { tier: string };
    expect(acct2.tier).toBe("standard");
    const dryAfterRefund = (await (await publish("@tieracct/existing", "hi", auth(a.token, { "x-dry-run": "1" }))).json()) as { plan: { cost_micros: number }[] };
    expect(dryAfterRefund.plan[0]!.cost_micros).toBe(stdLxmf);

    // Top up another $200 -> net $600 -> back to `bulk`.
    await stripeEvent({
      id: "evt_tier_bulk_2",
      type: "checkout.session.completed",
      data: { object: { id: "cs_tier_2", payment_intent: "pi_tier_2", payment_status: "paid", amount_total: 20000, metadata: { account_id: a.account_id } } },
    });
    expect(((await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { tier: string }).tier).toBe("bulk");

    // Simulate 366 days passing: daily cron rolls off old payments and downgrades back to `standard`.
    await refreshVolumeTiers(E, Date.now() + 366 * 86_400_000);
    expect(((await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { tier: string }).tier).toBe("standard");
    const dryExpired = (await (await publish("@tieracct/existing", "hi", auth(a.token, { "x-dry-run": "1" }))).json()) as { plan: { cost_micros: number }[] };
    expect(dryExpired.plan[0]!.cost_micros).toBe(stdLxmf);
  });
});
