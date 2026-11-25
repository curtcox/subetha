// Devices enroll at devicebasedauth.org (PLAN §9; mocked by mock-dba.mjs): the owner links their
// devicebasedauth.org account from the console, a DBA device then publishes with its credential
// within its grants, the console can pause it, and revoking it at devicebasedauth.org locks it out.
// The browser itself can enroll and attach a signing key for signed messages and E2EE keys.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SubEtha, generateDeviceKey } from "@subetha/sdk";
import { auth, BASE, bootstrap, dbaDevice, signIn } from "./helpers.ts";

/** Links the console's account to a fresh devicebasedauth.org account; returns that account. */
async function linkFromConsole(page: Page, request: APIRequestContext, token: string): Promise<string> {
  await page.locator('#tabs button[data-tab="devices"]').click();
  await expect(page.locator("#dbaStatus")).toContainText("Not linked yet");
  await page.locator("#dbaLink").click();
  await expect(page.locator("#dbaMsg")).toContainText("Linked devicebasedauth.org account acct_e2e");
  await expect(page).toHaveURL(/#tab=devices$/);
  const link = (await (await request.get("/v1/dba/link", { headers: auth(token) })).json()) as { linked: boolean; dba_account: string };
  expect(link.linked).toBe(true);
  await expect(page.locator("#dbaStatus")).toContainText(link.dba_account);
  return link.dba_account;
}

test("a devicebasedauth.org device publishes within its grants until it's revoked there", async ({ page, request }) => {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/garage`;
  await signIn(page, acct.token);
  const dbaAccount = await linkFromConsole(page, request, acct.token);

  // Enrolled and approved at devicebasedauth.org for this one topic only.
  const device = await dbaDevice(request, dbaAccount, [{ actions: ["subetha:publish", "subetha:subscribe"], resources: [topic] }], "garage-pi");
  const send = async (t: string, message: string) => {
    const url = `${BASE}/${t}`;
    return request.post(url, { headers: await device.headers("POST", url), data: message });
  };

  // The owner's console receives what it publishes.
  await page.locator('#tabs button[data-tab="messages"]').click();
  await page.locator("#subTopic").fill(topic);
  await page.locator("#subBtn").click();
  expect((await send(topic, "garage door closed")).status()).toBe(200);
  await expect(page.locator("#inbox li").first()).toContainText("garage door closed");
  expect((await send(`@${acct.handle}/other`, "not granted")).status()).toBe(403);

  // It appears under Devices; pausing it here blocks it until resumed.
  await page.locator('#tabs button[data-tab="devices"]').click();
  const row = page.locator("#devRows tr", { hasText: "garage-pi" });
  await expect(row).toContainText("active");
  await row.locator("button", { hasText: "Pause" }).click();
  await expect(row).toContainText("paused");
  expect((await send(topic, "while paused")).status()).toBe(403);
  await row.locator("button", { hasText: "Resume" }).click();
  await expect(row).toContainText("active");
  expect((await send(topic, "back online")).status()).toBe(200);

  // Revoked at devicebasedauth.org: refused at once (status lists are not cached here).
  await device.revoke();
  expect((await send(topic, "still there?")).status()).toBe(401);
});

test("subetha's own device-code enrollment is gone", async ({ request }) => {
  const r = await request.post("/v1/device/code", { data: {} });
  expect(r.status()).toBe(410);
});

test("this browser enrolls through devicebasedauth.org, signs messages, unwraps E2EE keys, and revokes itself", async ({ page, request, baseURL }) => {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/signed-box`;
  expect((await request.put(`/v1/topics/${topic}`, { headers: auth(acct.token), data: { policy: { require_signature: true } } })).ok()).toBe(true);

  await signIn(page, acct.token);
  const dbaAccount = await linkFromConsole(page, request, acct.token);
  await page.evaluate((a) => { (window as unknown as { __dbaTestAccount: string }).__dbaTestAccount = a; }, dbaAccount);
  await expect(page.locator("#thisDevSetup")).toBeVisible();
  await page.locator("#thisDevName").fill("work-laptop");
  await page.locator("#thisDevEnroll").click();
  await expect(page.locator("#thisDevStatus")).toContainText("Enrolled as work-laptop");
  const statusText = (await page.locator("#thisDevStatus").textContent()) ?? "";
  const devId = /dev_[a-z2-7]{52}/.exec(statusText)?.[0];
  expect(devId).toBeTruthy();
  await expect(page.locator("#devRows tr", { hasText: "(this browser)" })).toContainText("active");

  // Sign a message from Compose to a topic that requires signatures.
  await page.locator('#tabs button[data-tab="messages"]').click();
  await expect(page.locator("#pubSignWrap")).toBeVisible();
  await page.locator("#pubSign").check();
  await page.locator("#pubTopic").fill(topic);
  await page.locator("#pubMsg").fill("signed from browser");
  await page.locator("#pubBtn").click();
  await expect(page.locator("#pubOut")).toContainText(`"sender": "${devId}"`);
  await expect(page.locator("#pubOut")).toContainText('"sig": "ed25519:');

  // Wrap an E2EE key to this browser's device id from another client, publish ciphertext, and unwrap it in the console.
  const admin = new SubEtha({ baseUrl: baseURL!, token: acct.token });
  const key = crypto.getRandomValues(new Uint8Array(32));
  await admin.shareTopicKey(topic, "k-browser-1", key, [devId!]);
  const sender = new SubEtha({ baseUrl: baseURL!, token: acct.token, deviceKey: await generateDeviceKey(), topicKeys: { [topic]: { kid: "k-browser-1", key } } });
  await sender.publish(topic, "browser-only secret");

  await page.locator("#subTopic").fill(topic);
  await page.locator("#subBtn").click();
  await expect(page.locator("#inbox li").first()).toContainText("isn't in this browser");

  await page.locator('#tabs button[data-tab="devices"]').click();
  await page.locator("#thisDevLoadKeys").click();
  await expect(page.locator("#thisDevMsg")).toContainText(`Loaded 1 topic key: ${topic}`);

  await page.locator('#tabs button[data-tab="messages"]').click();
  await expect(page.locator("#inbox li").first()).toContainText("browser-only secret");

  // Revoke and forget this browser: its signing key and its devicebasedauth.org device.
  await page.locator('#tabs button[data-tab="devices"]').click();
  page.once("dialog", (d) => d.accept());
  await page.locator("#thisDevRevoke").click();
  await expect(page.locator("#thisDevMsg")).toHaveText("Revoked and forgotten.");
  await expect(page.locator("#thisDevSetup")).toBeVisible();
  for (const r of await page.locator("#devRows tr", { hasText: "work-laptop" }).all()) await expect(r).toContainText("revoked");
});
