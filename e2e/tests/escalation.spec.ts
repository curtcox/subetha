// Escalation end to end (PLAN §5, §14 tracks A and C): an urgent message that no device acks
// escalates to SMS and then to a voice call through the real delivery queue and its delays; one
// that reaches a listening console over the WebSocket is acked there, which stops the chain. Twilio is a local mock (mock-twilio.mjs);
// the test plays Twilio's part for the keypress and the call-status callback, signed like Twilio.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { asTwilio, auth, BASE, bootstrap, callsTo, signIn, verifiedPhone, type MockCall } from "./helpers.ts";

async function alarmSetup(request: APIRequestContext) {
  const acct = await bootstrap(request, 1);
  const topic = `@${acct.handle}/smoke`;
  await request.post(`/${topic}`, { headers: auth(acct.token), data: "init" }); // claims the topic
  const sms = await verifiedPhone(request, acct.token, "sms");
  const voice = await verifiedPhone(request, acct.token, "voice");
  for (const [ep, after_s, min_priority] of [[sms.id, 2, 4], [voice.id, 4, 5]] as const) {
    const r = await request.post("/v1/subscriptions", { headers: auth(acct.token), data: { topic, endpoint_id: ep, after_s, min_priority } });
    expect(r.status()).toBe(201);
  }
  return { acct, topic, sms, voice };
}

test("an alarm nobody acks escalates to SMS, then a call, and a keypress acks it", async ({ request }) => {
  test.setTimeout(90_000);
  const { acct, topic, sms, voice } = await alarmSetup(request);

  const dry = (await (await request.post(`/${topic}`, { headers: { ...auth(acct.token), "X-Dry-Run": "1", "X-Priority": "5" }, data: "x" })).json()) as { plan: { transport: string; after_s: number }[] };
  expect(dry.plan.map((d) => [d.transport, d.after_s])).toEqual(expect.arrayContaining([["sms", 2], ["voice", 4]]));

  const r = await request.post(`/${topic}`, { headers: { ...auth(acct.token), "X-Title": "Smoke", "X-Priority": "5" }, data: "Kitchen smoke detector" });
  expect(r.status()).toBe(200);
  const msg = (await r.json()) as { id: string };

  // After 2 s with no ack, an SMS.
  await expect.poll(async () => (await callsTo(request, sms.number)).filter((c) => c.body?.includes("Kitchen smoke detector")).length, { timeout: 30_000 }).toBe(1);

  // After 4 s, a call that reads the message and asks for a keypress.
  let call: MockCall | undefined;
  await expect.poll(async () => (call = (await callsTo(request, voice.number)).find((c) => c.twiml?.includes("Kitchen smoke detector"))) !== undefined, { timeout: 30_000 }).toBe(true);
  expect(call!.twiml).toContain("Press 1 to acknowledge");

  // The callee presses 1: Twilio posts the digit to the Gather action, which acks the message.
  const ackUrl = /action="([^"]+)"/.exec(call!.twiml!)![1]!.replaceAll("&amp;", "&");
  expect(ackUrl.startsWith(`${BASE}/v1/hooks/twilio/voice-ack`)).toBe(true);
  const ack = await asTwilio(request, ackUrl, { Digits: "1", CallSid: "CAmock" });
  expect(ack.ok()).toBe(true);
  expect(await ack.text()).toContain("Acknowledged");

  // The call ends after 40 s: the status callback settles the call to one minute.
  const status = await asTwilio(request, call!.status_callback!, { CallSid: "CAmock", CallStatus: "completed", CallDuration: "40" });
  expect(status.ok()).toBe(true);

  // The trace (owner only) shows every hop.
  const trace = (await (await request.get(`/v1/traces/${msg.id}?topic=${encodeURIComponent(topic)}`, { headers: auth(acct.token) })).json()) as { ack: { via: string } | null; events: { transport?: string; result?: string }[] };
  const delivered = (trace.events ?? []).filter((e) => e.result === "delivered").map((e) => e.transport);
  expect(delivered).toEqual(expect.arrayContaining(["sms", "voice"]));
  expect(trace.ack?.via).toBe("voice");
});

test("a console that receives the alarm live acks it, so nothing escalates", async ({ page, request }) => {
  test.setTimeout(60_000);
  const { acct, topic, sms, voice } = await alarmSetup(request);
  await signIn(page, acct.token, `#topic=${encodeURIComponent(topic)}`);
  await expect(page.locator("#subBtn")).toBeVisible();
  await page.waitForTimeout(1000); // let the WebSocket open before publishing

  const msg = (await (await request.post(`/${topic}`, { headers: { ...auth(acct.token), "X-Priority": "5" }, data: "False alarm" })).json()) as { id: string };
  await expect(page.locator("#inbox li").first()).toContainText("False alarm");

  // Both steps come due and are skipped, not sent.
  const traceUrl = `/v1/traces/${msg.id}?topic=${encodeURIComponent(topic)}`;
  let trace: { ack?: { via: string } | null; events?: { result?: string }[] } = {};
  await expect.poll(async () => {
    trace = (await (await request.get(traceUrl, { headers: auth(acct.token) })).json()) as typeof trace;
    return (trace.events ?? []).filter((e) => e.result === "skipped: acked").length;
  }, { timeout: 30_000 }).toBe(2);
  expect(trace.ack?.via).toBe("ws");
  expect((await callsTo(request, sms.number)).filter((c) => c.body?.includes("False alarm"))).toHaveLength(0);
  expect((await callsTo(request, voice.number)).filter((c) => c.twiml?.includes("False alarm"))).toHaveLength(0);
});
