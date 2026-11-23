// Payments and receipts on the billing panel (PLAN §11: "invoices/receipts").
import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { bootstrap, signIn } from "./helpers.ts";

/** A Stripe-Signature header (v1 scheme) for the secret serve.mjs gives wrangler dev. */
const stripeSig = (payload: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", "whsec_e2e").update(`${t}.${payload}`).digest("hex")}`;
};

test("a Stripe top-up shows on the billing panel with a printable receipt", async ({ page, request, context }) => {
  const a = await bootstrap(request, 0);
  const pi = `pi_e2e_${Date.now().toString(36)}`;
  const payload = JSON.stringify({ id: `evt_${pi}`, type: "checkout.session.completed", data: { object: { id: `cs_${pi}`, payment_intent: pi, payment_status: "paid", amount_total: 2000, metadata: { account_id: a.account_id } } } });
  const r = await request.post("/v1/hooks/stripe", { data: payload, headers: { "stripe-signature": stripeSig(payload), "content-type": "application/json" } });
  expect(r.status()).toBe(200);

  await signIn(page, a.token);
  await page.locator('#tabs button[data-tab="billing"]').click();
  const row = page.locator("#paymentRows tr").first();
  await expect(row).toContainText("$20.00");
  await expect(row).toContainText("$1.25");
  await expect(row).toContainText("$18.75");
  await expect(page.locator("#paymentsEmpty")).toBeHidden();

  const [receipt] = await Promise.all([context.waitForEvent("page"), row.getByRole("button", { name: "Receipt" }).click()]);
  await expect(receipt.locator("h1")).toHaveText("SubEtha receipt");
  await expect(receipt.locator("body")).toContainText(pi);
  await expect(receipt.locator("body")).toContainText(`@${a.handle}`);
  await expect(receipt.locator("body")).toContainText("$18.75");
});

test("auto-recharge can be configured and turned off once a card is saved", async ({ page, request }) => {
  const a = await bootstrap(request, 0);
  await signIn(page, a.token);
  await page.locator('#tabs button[data-tab="billing"]').click();
  await expect(page.locator("#arStatus")).toContainText("Save card");
  await expect(page.locator("#arForm")).toBeHidden();

  // A Stripe Checkout webhook carrying a customer saves the card on file.
  const pi = `pi_ar_${Date.now().toString(36)}`;
  const payload = JSON.stringify({ id: `evt_${pi}`, type: "checkout.session.completed", data: { object: { id: `cs_${pi}`, payment_intent: pi, payment_status: "paid", amount_total: 1000, customer: "cus_e2e_1", metadata: { account_id: a.account_id } } } });
  expect((await request.post("/v1/hooks/stripe", { data: payload, headers: { "stripe-signature": stripeSig(payload), "content-type": "application/json" } })).status()).toBe(200);

  await page.locator('#tabs button[data-tab="billing"]').click();
  await expect(page.locator("#arForm")).toBeVisible();
  await expect(page.locator("#arStatus")).toContainText("Auto-recharge is off");

  await page.locator("#arThreshold").fill("3");
  await page.locator("#arAmount").fill("15");
  await page.locator("#arSave").click();
  await expect(page.locator("#arMsg")).toHaveText("Saved.");
  await expect(page.locator("#arStatus")).toContainText("Active: tops up $15.00 when available balance drops below $3.00");
  await expect(page.locator("#arOff")).toBeVisible();

  await page.locator("#arOff").click();
  await expect(page.locator("#arMsg")).toHaveText("Turned off.");
  await expect(page.locator("#arStatus")).toContainText("Auto-recharge is off");
  await expect(page.locator("#arOff")).toBeHidden();
});
