// Sign in with devicebasedauth.org (mocked by mock-dba.mjs, which approves at once with a fresh
// DBA account): the console gets a session, a new account picks its handle, and a crafted link
// carrying someone else's sign-in doesn't sign this browser in.
import { expect, test } from "@playwright/test";

test("the console signs in with devicebasedauth.org and a new account picks its handle", async ({ page }) => {
  await page.goto("/console/");
  await page.locator("#dbaSignin").click();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page).toHaveURL(/\/console\/$/);
  await expect(page.locator("#create")).toBeVisible();
  const handle = `dba${Date.now().toString(36)}`;
  await page.locator("#handleInput").fill(handle);
  await page.locator("#createBtn").click();
  await expect(page.locator("#who")).toHaveText(`@${handle}`);
  await expect(page.locator("#create")).toBeHidden();

  await page.locator('#tabs button[data-tab="devices"]').click();
  await expect(page.locator("#dbaStatus")).toContainText("Linked to devicebasedauth.org account acct_e2e");
});

test("a sign-in that didn't start in this tab is refused", async ({ page, request }) => {
  const r = (await (await request.post("/v1/dba/signin/start")).json()) as { url: string };
  const state = new URL(r.url).searchParams.get("state");
  await page.goto(`/console/#dba-signin=1&code=whatever&state=${state}`);
  await expect(page.locator("#dbaSigninMsg")).toContainText("didn't start in this tab");
  await expect(page.locator("#signin")).toBeVisible();
});
