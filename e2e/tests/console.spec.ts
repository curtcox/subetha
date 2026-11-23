// The web console against a real relay under wrangler dev. The first test is the Phase 1 exit
// criterion (PLAN §14): a curl publish reaches the browser console, and the balance is debited.
import { expect, test } from "@playwright/test";
import { auth, balance, bootstrap, funds, headerFunds, price, signIn, usd } from "./helpers.ts";

test("curl publish reaches the console inbox and debits the balance", async ({ page, request }) => {
  const acct = await bootstrap(request, 0.005);
  const topic = `@${acct.handle}/doorbell`;
  await signIn(page, acct.token);
  await expect(page.locator("#who")).toHaveText(`@${acct.handle}`);
  await expect(page.locator("#bal")).toHaveText(usd(5000));

  await page.locator("#subTopic").fill(topic);
  await page.locator("#subBtn").click();

  // curl -H "Authorization: Bearer …" -H "X-Title: Front door" -H "X-Priority: 4" -d Opened …/@handle/doorbell
  const r = await request.post(`/${topic}`, { headers: { ...auth(acct.token), "X-Title": "Front door", "X-Priority": "4" }, data: "Opened" });
  expect(r.status()).toBe(200);
  const msg = (await r.json()) as { id: string };

  const item = page.locator("#inbox li").first();
  await expect(item).toContainText("Front door");
  await expect(item).toContainText("Opened");
  await expect(item).toContainText(`${topic} p4`);

  // The publisher paid for the publish; fan-out is paid from a lease the topic took, which shows as held.
  const publish = await price(request, "publish");
  const after = await funds(request, acct.token);
  expect(after.total).toBeLessThanOrEqual(5000 - publish);
  expect(after.total).toBeGreaterThan(4900);
  expect(after.available).toBeGreaterThanOrEqual(0);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await expect.poll(() => headerFunds(page)).toBe((await funds(request, acct.token)).total);

  // The ledger shows the top-up, then the reserve and settle for this publish.
  await page.locator('#tabs button[data-tab="billing"]').click();
  const rows = page.locator("#ledgerRows tr");
  await expect(rows.filter({ hasText: "topup" })).toHaveCount(1);
  const forMsg = rows.filter({ hasText: `pub:${msg.id}` });
  await expect(forMsg.filter({ hasText: "reserve" })).toHaveCount(1);
  await expect(forMsg.filter({ hasText: "settle" })).toHaveCount(1);
});

test("a message composed in one console arrives in another, with a trace", async ({ browser, request }) => {
  const acct = await bootstrap(request, 0.005); // under a cent the header shows µ$, so a debit is visible
  const topic = `@${acct.handle}/alerts`;
  const receiver = await (await browser.newContext()).newPage();
  const sender = await (await browser.newContext()).newPage();

  // Signing in with #topic= in the URL subscribes on load.
  await signIn(receiver, acct.token, `#topic=${encodeURIComponent(topic)}`);
  await signIn(sender, acct.token);
  await sender.locator("#pubTopic").fill(topic);
  await sender.locator("#pubTitle").fill("Smoke");
  await sender.locator("#pubMsg").fill("Kitchen sensor tripped");
  await sender.locator("#pubPrio").selectOption("5");
  await sender.locator("#pubTags").fill("fire,kitchen");
  await sender.locator("#pubBtn").click();

  await expect(sender.locator("#pubOut")).toContainText('"message": "Kitchen sensor tripped"');
  const id = await sender.locator("#traceId").inputValue();
  expect(id).toMatch(/^[0-9A-Z]{26}$/);
  const item = receiver.locator("#inbox li").first();
  await expect(item).toContainText("Kitchen sensor tripped");
  await expect(item).toContainText(`${topic} p5`);
  await expect.poll(() => headerFunds(sender)).toBeLessThanOrEqual(5000 - (await price(request, "publish")));

  await sender.locator('#tabs button[data-tab="traces"]').click();
  await sender.locator("#traceBtn").click();
  await expect(sender.locator("#traceOut")).toContainText(id);
});

test("a dry run prices the route for the price of an API call, not a publish", async ({ page, request }) => {
  const acct = await bootstrap(request, 1);
  await signIn(page, acct.token);
  const apiCall = await price(request, "api_request");
  const before = await balance(request, acct.token);
  await page.locator("#pubTopic").fill(`@${acct.handle}/dry`);
  await page.locator("#pubMsg").fill("just checking");
  await page.locator("#dryBtn").click();
  await expect(page.locator("#pubOut")).toContainText("Estimated cost: $");
  // Rule 0 (PLAN §8): nothing on the relay is free, but a dry run is metered as an ordinary API call.
  expect(before - (await balance(request, acct.token))).toBe(apiCall);
  const r = await request.get(`/@${acct.handle}/dry/json?poll=1`, { headers: auth(acct.token) });
  expect(await r.text()).not.toContain("just checking");
});

test("an empty balance gets HTTP 402 with the shortfall, in curl and in the console", async ({ page, request }) => {
  const acct = await bootstrap(request, 0);
  const topic = `@${acct.handle}/doorbell`;
  const r = await request.post(`/${topic}`, { headers: auth(acct.token), data: "hello?" });
  expect(r.status()).toBe(402);
  const body = (await r.json()) as { error: string; shortfall_usd_micros: number };
  expect(body.error).toBe("insufficient_balance");
  expect(body.shortfall_usd_micros).toBeGreaterThan(0);

  await signIn(page, acct.token);
  await expect(page.locator("#bal")).toHaveText(usd(0));
  await page.locator("#pubTopic").fill(topic);
  await page.locator("#pubBtn").click();
  await expect(page.locator("#pubOut")).toContainText("insufficient_balance");
  expect(await balance(request, acct.token)).toBe(0);
});

test("a token made in the console is limited to its scopes", async ({ page, request }) => {
  const acct = await bootstrap(request, 1);
  await signIn(page, acct.token);
  await page.locator('#tabs button[data-tab="tokens"]').click();
  await page.locator("#tokName").fill("doorbell only");
  await page.locator("#tokScopes").fill(`publish:@${acct.handle}/doorbell`);
  await page.locator("#tokDaily").fill("0.50");
  await page.locator("#tokTotal").fill("2.00");
  await page.locator("#tokExpires").fill("24");
  await page.locator("#tokCreate").click();
  await expect(page.locator("#tokOut")).toContainText("Shown once");
  const token = ((await page.locator("#tokOut").textContent()) ?? "").split("\n")[0]?.trim() ?? "";
  expect(token).toMatch(/^se_/);
  await expect(page.locator("#tokenRows")).toContainText("doorbell only");
  await expect(page.locator("#tokenRows")).toContainText("$0.50/day");
  await expect(page.locator("#tokenRows")).toContainText("$2.00 total");

  expect((await request.post(`/@${acct.handle}/doorbell`, { headers: auth(token), data: "ding" })).status()).toBe(200);
  expect((await request.post(`/@${acct.handle}/garage`, { headers: auth(token), data: "ding" })).status()).toBe(403);
});

test("attachments can be uploaded from Compose and downloaded from the inbox", async ({ page, request }) => {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/files`;
  await signIn(page, acct.token);
  await page.locator("#subTopic").fill(topic);
  await page.locator("#subBtn").click();

  await page.locator("#pubTopic").fill(topic);
  await page.locator("#pubMsg").fill("Sensor log");
  await page.locator("#pubMore summary").click();
  await page.locator("#pubClick").fill("https://example.com/logs");
  await page.locator("#pubFile").setInputFiles({ name: "log.txt", mimeType: "text/plain", buffer: Buffer.from("temp=21.5C\n") });
  await page.locator("#pubBtn").click();

  await expect(page.locator("#pubOut")).toContainText('"name": "log.txt"');
  const item = page.locator("#inbox li").first();
  await expect(item).toContainText("Sensor log");
  await expect(item).toContainText("log.txt");
  await expect(item).toContainText("https://example.com/logs");
  const href = await item.locator('a', { hasText: "log.txt" }).getAttribute("href");
  expect(href).toContain("/file/");
  const dl = await request.get(href!);
  expect(dl.status()).toBe(200);
  expect(await dl.text()).toBe("temp=21.5C\n");
});

test("the live inbox filters by priority and tags and jumps to a message trace", async ({ page, request }) => {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/filtered`;
  expect((await request.post(`/${topic}`, { headers: auth(acct.token), data: "init" })).ok()).toBe(true);

  await signIn(page, acct.token);
  await page.locator("#subTopic").fill(topic);
  await page.locator("#inboxPrio").fill("4,5");
  await page.locator("#inboxTags").fill("alarm");
  await page.locator("#subBtn").click();

  // Low priority and wrong-tag messages should not appear; matching message should.
  await request.post(`/${topic}`, { headers: { ...auth(acct.token), "X-Priority": "2", "X-Tags": "alarm" }, data: "too quiet" });
  await request.post(`/${topic}`, { headers: { ...auth(acct.token), "X-Priority": "5", "X-Tags": "info" }, data: "wrong tag" });
  const match = await request.post(`/${topic}`, { headers: { ...auth(acct.token), "X-Priority": "5", "X-Tags": "alarm,door" }, data: "intruder alert" });
  const { id } = (await match.json()) as { id: string };

  const item = page.locator("#inbox li").first();
  await expect(item).toContainText("intruder alert");
  await expect(page.locator("#inbox")).not.toContainText("too quiet");
  await expect(page.locator("#inbox")).not.toContainText("wrong tag");

  // Jump straight to the trace from the inbox item.
  await item.getByRole("button", { name: "Trace" }).click();
  await expect(page.locator('[data-panel="traces"]')).toBeVisible();
  await expect(page.locator("#traceOut")).toContainText(id);
  await expect(page.locator("#traceOut")).toContainText("Delivery plan");
  await expect(page.locator("#traceOut")).toContainText("deliver_live");
});
