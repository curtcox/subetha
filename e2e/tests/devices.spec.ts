// Device enrollment (PLAN §9, Track A): a device asks for a code, the owner approves it in the
// console, the device publishes with signed requests (no bearer token), and revoking it in the
// console locks it out.
import { expect, test } from "@playwright/test";
import { SubEtha, enrollmentProof, generateDeviceKey } from "@subetha/sdk";
import { auth, bootstrap, signIn } from "./helpers.ts";

test("a device enrolled from the console publishes with signed requests until it's revoked", async ({ page, request, baseURL }) => {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/garage`;

  // On the device: a key, a proof of possession, and a short code to show the owner.
  const key = await generateDeviceKey();
  const start = await request.post("/v1/device/code", { data: { ...(await enrollmentProof(key)), name: "garage-pi", capabilities: ["ws", "lan"] } });
  expect(start.status()).toBe(200);
  const code = (await start.json()) as { device_code: string; user_code: string; verification_uri_complete: string };
  expect(code.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  const pending = await request.post("/v1/device/token", { data: { device_code: code.device_code } });
  expect(((await pending.json()) as { error?: string }).error).toBe("authorization_pending");

  // The owner opens the verification link: the Devices tab, with the code filled in.
  const link = new URL(code.verification_uri_complete);
  expect(link.pathname).toBe("/console/");
  await signIn(page, acct.token, link.hash);
  await expect(page.locator('[data-panel="devices"]')).toBeVisible();
  await expect(page.locator("#devCode")).toHaveValue(code.user_code);
  await page.locator("#devApprove").click();
  await expect(page.locator("#devMsg")).toContainText("Enrolled garage-pi");
  const row = page.locator("#devRows tr", { hasText: "garage-pi" });
  await expect(row).toContainText("active");
  await expect(row).toContainText("ws, lan");

  // The device finishes signing in by itself.
  const done = (await (await request.post("/v1/device/token", { data: { device_code: code.device_code } })).json()) as { device_id?: string };
  expect(done.device_id).toBe(key.deviceId);

  // It publishes with request signatures; the owner's console receives the message.
  await page.locator('#tabs button[data-tab="messages"]').click();
  await page.locator("#subTopic").fill(topic);
  await page.locator("#subBtn").click();
  const device = new SubEtha({ baseUrl: baseURL!, deviceKey: key, signRequests: true });
  await device.publish(topic, "garage door closed");
  await expect(page.locator("#inbox li").first()).toContainText("garage door closed");

  // Revoked in the console, the device can't publish any more.
  await page.locator('#tabs button[data-tab="devices"]').click();
  page.once("dialog", (d) => d.accept());
  await row.locator("button", { hasText: "Revoke" }).click();
  await expect(row).toContainText("revoked");
  const err = await device.publish(topic, "still there?").then(() => null, (e: { code?: string }) => e);
  expect(err?.code).toBe("unauthorized");
});

test("a device provisioned by hand is enrolled by pasting its enrollment proof", async ({ page, request }) => {
  const acct = await bootstrap(request, 1);
  const key = await generateDeviceKey();
  await signIn(page, acct.token);
  await page.locator('#tabs button[data-tab="devices"]').click();
  await page.locator("#devId").fill("dev_not-json");
  await page.locator("#devEnroll").click();
  await expect(page.locator("#devEnrollMsg")).toContainText("paste the JSON");
  await page.locator("#devId").fill(JSON.stringify(await enrollmentProof(key)));
  await page.locator("#devName").fill("shed-sensor");
  await page.locator("#devEnroll").click();
  await expect(page.locator("#devEnrollMsg")).toHaveText("Enrolled.");
  await expect(page.locator("#devRows tr", { hasText: "shed-sensor" })).toContainText("active");
});

test("this browser can enroll as a device, sign messages, unwrap E2EE keys, and revoke itself", async ({ page, request, baseURL }) => {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/signed-box`;
  expect((await request.put(`/v1/topics/${topic}`, { headers: auth(acct.token), data: { policy: { require_signature: true } } })).ok()).toBe(true);

  await signIn(page, acct.token);
  await page.locator('#tabs button[data-tab="devices"]').click();
  await expect(page.locator("#thisDevSetup")).toBeVisible();
  await page.locator("#thisDevName").fill("work-laptop");
  await page.locator("#thisDevEnroll").click();
  await expect(page.locator("#thisDevStatus")).toContainText("Enrolled as work-laptop");
  const statusText = (await page.locator("#thisDevStatus").textContent()) ?? "";
  const devId = /dev_[a-z2-7]{52}/.exec(statusText)?.[0];
  expect(devId).toBeTruthy();
  await expect(page.locator("#devRows tr", { hasText: "work-laptop" })).toContainText("(this browser)");

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

  // Revoke and forget this browser.
  await page.locator('#tabs button[data-tab="devices"]').click();
  page.once("dialog", (d) => d.accept());
  await page.locator("#thisDevRevoke").click();
  await expect(page.locator("#thisDevMsg")).toHaveText("Revoked and forgotten.");
  await expect(page.locator("#thisDevSetup")).toBeVisible();
  await expect(page.locator("#devRows tr", { hasText: "work-laptop" })).toContainText("revoked");
});
