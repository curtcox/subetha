import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signStripePayload } from "../src/stripe.ts";
import type { Env } from "../src/types.ts";
import { auth, balance, BASE, bootstrap } from "./helpers.ts";

const E = env as unknown as Env;
afterEach(() => vi.unstubAllGlobals());

async function hook(evt: unknown) {
  const payload = JSON.stringify(evt);
  return SELF.fetch(`${BASE}/v1/hooks/stripe`, { method: "POST", body: payload, headers: { "stripe-signature": await signStripePayload(payload, "whsec_test") } });
}

describe("auto-recharge", () => {
  it("needs a saved card, charges off-session when low, and credits via webhook", async () => {
    const a = await bootstrap("recharger", 0);
    const getAccount = async () => (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { has_saved_card: boolean; auto_recharge: { threshold_micros: number; amount_micros: number } | null };
    const patch = (body: unknown) => SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify(body) });
    expect(await getAccount()).toMatchObject({ has_saved_card: false, auto_recharge: null });
    expect((await patch({ auto_recharge: { threshold_usd: 2, amount_usd: 10 } })).status).toBe(409);

    // First top-up through Checkout saves the customer.
    await hook({ id: "evt_ar1", type: "checkout.session.completed", data: { object: { id: "cs_ar1", payment_status: "paid", amount_total: 500, customer: "cus_123", metadata: { account_id: a.account_id } } } });
    expect(await balance(a.token)).toBe(5_000_000 - 575_000);
    expect(await getAccount()).toMatchObject({ has_saved_card: true, auto_recharge: null });
    expect((await patch({ auto_recharge: { threshold_usd: 5, amount_usd: 10 } })).status).toBe(200);
    expect(await getAccount()).toMatchObject({ has_saved_card: true, auto_recharge: { threshold_micros: 5_000_000, amount_micros: 10_000_000 } });

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url + " " + (init?.body ?? ""));
      if (url.includes("/payment_methods")) return new Response(JSON.stringify({ data: [{ id: "pm_1" }] }));
      return new Response(JSON.stringify({ id: "pi_1", status: "succeeded" }));
    });
    const stub = E.ACCOUNT.get(E.ACCOUNT.idFromName(a.account_id));
    await runDurableObjectAlarm(stub);
    const pi = calls.find((c) => c.includes("/v1/payment_intents"))!;
    expect(pi).toContain("amount=1000");
    expect(pi).toContain("customer=cus_123");
    expect(pi).toContain("off_session=true");
    // Cooldown: a second alarm doesn't charge again.
    await runDurableObjectAlarm(stub);
    expect(calls.filter((c) => c.includes("/v1/payment_intents"))).toHaveLength(1);
    vi.unstubAllGlobals();

    const before = await balance(a.token);
    const ok = { id: "evt_ar2", type: "payment_intent.succeeded", data: { object: { id: "pi_1", amount: 1000, metadata: { account_id: a.account_id, auto_recharge: "1" } } } };
    await hook(ok);
    await hook({ ...ok, id: "evt_ar2b" }); // same PI, different event: credited once
    expect(await balance(a.token)).toBe(before + 10_000_000 - 800_000);

    await hook({ id: "evt_ar3", type: "payment_intent.payment_failed", data: { object: { id: "pi_2", amount: 1000, metadata: { account_id: a.account_id, auto_recharge: "1" } } } });
    const row = await E.DB.prepare("SELECT auto_recharge FROM accounts WHERE id = ?").bind(a.account_id).first<{ auto_recharge: string | null }>();
    expect(row?.auto_recharge).toBeNull();
  });
});
