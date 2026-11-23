// End-to-end encryption from the console (PLAN §9, §11; spec §5.1): the owner makes a topic key,
// which is wrapped to an enrolled device; the console encrypts what it sends and decrypts its
// inbox; the relay stores only ciphertext; the device opens its wrapped key and reads the message.
import { expect, test } from "@playwright/test";
import { SubEtha, enrollmentProof, generateDeviceKey } from "@subetha/sdk";
import { auth, bootstrap, signIn } from "./helpers.ts";

test("a topic key made in the console encrypts messages that only the console and the device can read", async ({ page, request, baseURL }) => {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/vault`;
  expect((await request.post(`/${topic}`, { headers: auth(acct.token), data: "init" })).ok()).toBe(true);
  const key = await generateDeviceKey();
  expect((await request.post("/v1/devices", { headers: auth(acct.token), data: { ...(await enrollmentProof(key)), name: "vault-pi" } })).ok()).toBe(true);

  await signIn(page, acct.token);
  await page.locator('#tabs button[data-tab="topics"]').click();
  await page.locator("#keyTopic").selectOption(topic);
  await expect(page.locator("#keyDevices")).toContainText("vault-pi");
  await page.locator("#keyNew").click();
  await expect(page.locator("#keyMsg")).toHaveText("Wrapped for 1 device.");
  await expect(page.locator("#keyOut")).toContainText("Key id: k");
  await expect(page.locator("#keyRows")).toContainText("vault-pi");
  await expect(page.locator("#localKeyRows")).toContainText(topic);
  const shared = /Key id: (\S+)\nKey: (\S+)/.exec((await page.locator("#keyOut").textContent())!)!;

  // The console encrypts to the topic and decrypts its own inbox.
  await page.locator('#tabs button[data-tab="messages"]').click();
  await page.locator("#subTopic").fill(topic);
  await page.locator("#subBtn").click();
  await page.locator("#pubTopic").fill(topic);
  await page.locator("#pubMsg").fill("the combination is 4-8-15");
  await page.locator("#pubBtn").click();
  await expect(page.locator("#inbox li").first()).toContainText("the combination is 4-8-15");

  // The relay has only ciphertext.
  const lines = (await (await request.get(`/${topic}/json?poll=1&since=all`, { headers: auth(acct.token) })).text()).trim().split("\n");
  const stored = JSON.parse(lines.at(-1)!) as { message: string; enc?: { kid: string } };
  expect(stored.enc?.kid).toBe(shared[1]);
  expect(stored.message).not.toContain("combination");

  // The device opens its wrapped key and reads the message.
  const device = new SubEtha({ baseUrl: baseURL!, deviceKey: key, signRequests: true });
  const loaded = await device.loadTopicKeys({ topic });
  expect(loaded[topic]?.kid).toBe(shared[1]);
  expect((await device.poll(topic, { since: "all" })).at(-1)).toMatchObject({ message: "the combination is 4-8-15" });

  // Forgotten in this browser, the inbox shows the message is encrypted; pasting the key back opens it.
  await page.locator('#tabs button[data-tab="topics"]').click();
  await page.locator(`[data-keyforget="${topic}"]`).click();
  await expect(page.locator("#localKeyRows")).toContainText("No keys in this browser.");
  await page.locator('#tabs button[data-tab="messages"]').click();
  await expect(page.locator("#inbox li").first()).toContainText("isn't in this browser");
  await page.locator('#tabs button[data-tab="topics"]').click();
  await page.locator("#keyAddTopic").fill(topic);
  await page.locator("#keyAddKid").fill(shared[1]!);
  await page.locator("#keyAddKey").fill(shared[2]!);
  await page.locator("#keyAdd").click();
  await page.locator('#tabs button[data-tab="messages"]').click();
  await expect(page.locator("#inbox li").first()).toContainText("the combination is 4-8-15");
});
