import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { receiptHtml, toPayment } from "../src/payments.ts";
import { signStripePayload } from "../src/stripe.ts";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap } from "./helpers.ts";

const E = env as unknown as Env;

async function hook(evt: unknown) {
  const payload = JSON.stringify(evt);
  const r = await SELF.fetch(`${BASE}/v1/hooks/stripe`, { method: "POST", body: payload, headers: { "stripe-signature": await signStripePayload(payload, "whsec_test") } });
  expect(r.status).toBe(200);
}

describe("payments and receipts", () => {
  it("lists payments with fee, credit, refunds, and serves a receipt", async () => {
    const a = await bootstrap("payer", 0);
    await hook({ id: "evt_pay1", type: "checkout.session.completed", data: { object: { id: "cs_pay1", payment_intent: "pi_pay1", payment_status: "paid", amount_total: 2000, metadata: { account_id: a.account_id } } } });
    await hook({ id: "evt_pay2", type: "payment_intent.succeeded", data: { object: { id: "pi_pay2", amount: 1000, metadata: { account_id: a.account_id, auto_recharge: "1" } } } });
    await hook({ id: "evt_pay3", type: "charge.refunded", data: { object: { payment_intent: "pi_pay1", amount_refunded: 500 } } });

    const r = await SELF.fetch(`${BASE}/v1/payments`, { headers: auth(a.token) });
    expect(r.status).toBe(200);
    const { payments } = (await r.json()) as { payments: ReturnType<typeof toPayment>[] };
    const byId = Object.fromEntries(payments.map((p) => [p.id, p]));
    expect(byId.pi_pay1).toMatchObject({ kind: "checkout", amount_micros: 20_000_000, fee_micros: 1_250_000, credit_micros: 18_750_000, refunded_micros: 5_000_000, disputed: false });
    expect(byId.pi_pay2).toMatchObject({ kind: "auto_recharge", amount_micros: 10_000_000, fee_micros: 800_000, credit_micros: 9_200_000 });

    const rec = await SELF.fetch(`${BASE}/v1/payments/pi_pay1/receipt`, { headers: auth(a.token) });
    expect(rec.status).toBe(200);
    expect(rec.headers.get("content-type")).toMatch(/text\/html/);
    expect(rec.headers.get("cache-control")).toContain("no-store");
    const html = await rec.text();
    for (const s of ["pi_pay1", "@payer", "$20.00", "$1.25", "$18.75", "Refunded", "−$5.00"]) expect(html).toContain(s);

    // Another account can't see it.
    const b = await bootstrap("nosy", 0);
    expect((await SELF.fetch(`${BASE}/v1/payments/pi_pay1/receipt`, { headers: auth(b.token) })).status).toBe(404);
    expect(((await (await SELF.fetch(`${BASE}/v1/payments`, { headers: auth(b.token) })).json()) as { payments: unknown[] }).payments).toEqual([]);
  });

  it("recomputes the fee for rows recorded before fees were stored", async () => {
    const a = await bootstrap("oldpay", 0);
    await E.DB.prepare("INSERT INTO stripe_payments (payment_intent, account_id, amount_micros, created_at) VALUES ('pi_old', ?, 50000000, 1)").bind(a.account_id).run();
    const { payments } = (await (await SELF.fetch(`${BASE}/v1/payments`, { headers: auth(a.token) })).json()) as { payments: ReturnType<typeof toPayment>[] };
    expect(payments[0]).toMatchObject({ id: "pi_old", kind: "checkout", fee_micros: 2_600_000, credit_micros: 47_400_000 });
  });

  it("escapes account details in the receipt", () => {
    const html = receiptHtml(
      { id: "pi_<x>", kind: "checkout", amount_micros: 5e6, fee_micros: 1e5, credit_micros: 4.9e6, refunded_micros: 0, disputed: true, created_at: 0 },
      { id: "acct", handle: null, email: "a\"<b>@example.com" },
    );
    expect(html).not.toContain("<x>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Disputed");
  });
});
