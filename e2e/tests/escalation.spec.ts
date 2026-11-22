// Escalation end to end (PLAN §5, §14 tracks A and C): an urgent message that no device acks
// escalates to SMS and then to a voice call through the real delivery queue and its delays; one
// that reaches a listening console over the WebSocket is acked there, which stops the chain. Twilio is a local mock (mock-twilio.mjs);
// the test plays Twilio's part for the keypress and the call-status callback, signed like Twilio.
import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { auth, bootstrap, signIn } from "./helpers.ts";

const TWILIO = `http://localhost:${Number(process.env.E2E_PORT ?? 8788) + 2}`;
const TWILIO_TOKEN = "e2e-twilio-token"; // serve.mjs
const BASE = `http://localhost:${process.env.E2E_PORT ?? 8788}`;

interface MockCall { kind: "sms" | "voice"; to: string; body?: string; twiml?: string; status_callback?: string; auth?: string }

/** A US number no other test uses, so the shared mock's records stay apart. */
const uniqueNumber = () => `+1415${String(2 + Math.floor(Math.random() * 8))}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

async function callsTo(request: APIRequestContext, to: string): Promise<MockCall[]> {
  return (await (await request.get(`${TWILIO}/__calls?to=${encodeURIComponent(to)}`)).json()) as MockCall[];
}

function twilioSignature(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", TWILIO_TOKEN).update(data).digest("base64");
}

/** POSTs a form to the relay as Twilio would, with X-Twilio-Signature. */
async function asTwilio(request: APIRequestContext, url: string, params: Record<string, string>) {
  return request.post(url, { form: params, headers: { "X-Twilio-Signature": twilioSignature(url, params) } });
}

/** Adds an SMS or voice endpoint and verifies it with the code the relay sent through the mock. */
async function verifiedPhone(request: APIRequestContext, token: string, kind: "sms" | "voice"): Promise<{ id: string; number: string }> {
  const number = uniqueNumber();
  const r = await request.post("/v1/endpoints", { headers: auth(token), data: { kind, address: number } });
  expect(r.status()).toBe(201);
  const ep = (await r.json()) as { id: string };
  const [sent] = await callsTo(request, number);
  expect(sent?.kind).toBe(kind);
  const text = kind === "sms" ? sent!.body! : /code is ([^.]*)\./.exec(sent!.twiml!)![1]!;
  const code = text.replace(/\D/g, "").slice(0, 6);
  expect(code).toMatch(/^\d{6}$/);
  const v = await request.post(`/v1/endpoints/${ep.id}/verify`, { headers: auth(token), data: { code } });
  expect(v.ok()).toBe(true);
  return { id: ep.id, number };
}

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
