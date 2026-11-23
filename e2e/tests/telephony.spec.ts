// SMS/voice countries outside the US: the billing panel's opt-in card (PLAN §8, rule 5).
import { expect, test } from "@playwright/test";
import { auth, bootstrap, signIn } from "./helpers.ts";

test("the billing panel enables SMS and voice countries outside the US", async ({ page, request }) => {
  const a = await bootstrap(request, 1);
  await signIn(page, a.token);
  await page.locator('#tabs button[data-tab="billing"]').click();

  const card = page.locator("#telCountries");
  await expect(card.getByRole("checkbox", { name: "United Kingdom" })).toBeVisible();
  // No pricing job has run under wrangler dev, so nothing has a price yet.
  await expect(card).toContainText("No prices yet today.");
  await card.getByRole("checkbox", { name: "United Kingdom" }).check();
  await card.getByRole("checkbox", { name: "Canada" }).check();
  await page.locator("#telSave").click();
  await expect(page.locator("#telMsg")).toHaveText("Saved.");

  const acct = (await (await request.get("/v1/account", { headers: auth(a.token) })).json()) as { telephony_countries: string[] };
  expect(acct.telephony_countries).toEqual(["CA", "GB"]);

  // Unpriced destinations are rejected even once enabled.
  const r = await request.post("/v1/endpoints", { headers: auth(a.token), data: { kind: "sms", address: "+447700900123" } });
  expect(r.status()).toBe(503);
  expect(((await r.json()) as { message: string }).message).toContain("no current sms price for GB");

  // Unchecking and saving turns a country off again.
  await card.getByRole("checkbox", { name: "Canada" }).uncheck();
  await page.locator("#telSave").click();
  await expect.poll(async () => ((await (await request.get("/v1/account", { headers: auth(a.token) })).json()) as { telephony_countries: string[] }).telephony_countries).toEqual(["GB"]);
});
