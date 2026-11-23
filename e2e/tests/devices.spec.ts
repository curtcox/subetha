// Device enrollment (PLAN §9, Track A): a device asks for a code, the owner approves it in the
// console, the device publishes with signed requests (no bearer token), and revoking it in the
// console locks it out.
import { expect, test } from "@playwright/test";
import { SubEtha, enrollmentProof, generateDeviceKey } from "@subetha/sdk";
import { bootstrap, signIn } from "./helpers.ts";

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
