// The endpoint inspector (PLAN §10): a test delivery from the console shows the signed request,
// and the in-browser checker verifies its signature with the endpoint's secret.
import { expect, test } from "@playwright/test";
import { auth, balance, bootstrap, price, signIn } from "./helpers.ts";

test("testing a webhook endpoint shows the signed request, and the signature checks out", async ({ page, request }) => {
  const acct = await bootstrap(request, 0.05);
  // `.invalid` never resolves, so the delivery fails the same way everywhere, after the request is built.
  const r = await request.post("/v1/endpoints", { headers: auth(acct.token), data: { kind: "webhook", address: "https://hooks.invalid/subetha" } });
  expect(r.status()).toBe(201);
  const ep = (await r.json()) as { id: string; secret: string };

  await signIn(page, acct.token);
  await page.locator('#tabs button[data-tab="endpoints"]').click();
  const before = await balance(request, acct.token);
  await page.locator("#insTitle").fill("Inspector E2E");
  await page.locator(`[data-eptest="${ep.id}"]`).click();

  const out = page.locator("#insOut");
  await expect(out).toContainText("failed");
  await expect(out).toContainText("POST https://hooks.invalid/subetha");
  await expect(out).toContainText("x-subetha-signature: t=");
  await expect(out).toContainText('"title": "Inspector E2E"');
  // A test is a real delivery attempt, so it's charged either way.
  expect(await balance(request, acct.token)).toBe(before - (await price(request, "deliver_webhook")));

  // The checker is prefilled with the header and raw body; only the secret is needed.
  await page.locator("#inspector summary").click();
  await expect(page.locator("#sigHeader")).toHaveValue(/^t=\d+,v1=[0-9a-f]{64}$/);
  await page.locator("#sigSecret").fill(ep.secret);
  await page.locator("#sigCheck").click();
  await expect(page.locator("#sigOut")).toContainText("signature matches");
  await page.locator("#sigSecret").fill("whsec_wrong");
  await page.locator("#sigCheck").click();
  await expect(page.locator("#sigOut")).toContainText("does not match");
});
