// SMS/voice countries outside the US: the billing panel's opt-in card (PLAN §8, rule 5); texting in
// to a topic from a verified number (PLAN §6).
import { expect, test } from "@playwright/test";
import { asTwilio, auth, BASE, bootstrap, signIn, verifiedPhone } from "./helpers.ts";

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

test("the endpoints panel routes texts from a verified number to a topic", async ({ page, request }) => {
  const a = await bootstrap(request, 1);
  const topic = `@${a.handle}/texts`;
  expect((await request.post(`/${topic}`, { headers: auth(a.token), data: "init" })).ok()).toBe(true);
  const phone = await verifiedPhone(request, a.token, "sms");

  await signIn(page, a.token);
  await page.locator('#tabs button[data-tab="endpoints"]').click();
  page.once("dialog", (d) => d.accept(topic));
  await page.locator(`[data-epinbound="${phone.id}"]`).click();
  await expect(page.locator("#epRows")).toContainText(`texts in → ${topic}`);

  const r = await asTwilio(request, `${BASE}/v1/hooks/twilio/sms`, { From: phone.number, Body: "on my way", MessageSid: `SMe2e${Date.now()}`, NumMedia: "0" });
  expect(r.ok()).toBe(true);
  const lines = (await (await request.get(`/${topic}/json?poll=1&since=all`, { headers: auth(a.token) })).text()).trim().split("\n");
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ message: "on my way", tags: ["sms"] });

  // An empty answer turns texting in off.
  page.once("dialog", (d) => d.accept(""));
  await page.locator(`[data-epinbound="${phone.id}"]`).click();
  await expect(page.locator("#epRows")).not.toContainText("texts in");
});
