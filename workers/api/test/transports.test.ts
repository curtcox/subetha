import { createExecutionContext, createMessageBatch, env, getQueueResult, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { processJob } from "../src/delivery/consumer.ts";
import { checkTwilioPrices, CIRCUIT_KEY, providerCeilingUsd } from "../src/cron.ts";
import type { PriceTable } from "@subetha/pricing";
import PRICES from "@subetha/pricing/prices.json";
import { signWebhook } from "../src/delivery/webhook.ts";
import { smsSegments, twilioSignature, verifyTwilioSignature, voiceTwiml } from "../src/delivery/twilio.ts";
import { verifySlackSignature } from "../src/delivery/slack.ts";
import { hmacSha256Hex } from "../src/crypto.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { auth, balance, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;
const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

/** Stub outbound fetch for provider hosts; pass everything else (SELF) through. */
function stubProviders(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    const req = input instanceof Request ? input : null;
    const i = req ? { method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() } : init;
    calls.push({ url, init: i });
    return handler(url, i);
  });
  return calls;
}

async function json<T = Record<string, unknown>>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

describe("unit helpers", () => {
  it("counts SMS segments for GSM-7 and UCS-2", () => {
    expect(smsSegments("hello")).toBe(1);
    expect(smsSegments("x".repeat(160))).toBe(1);
    expect(smsSegments("x".repeat(161))).toBe(2);
    expect(smsSegments("{".repeat(81))).toBe(2); // extension chars count double
    expect(smsSegments("é".repeat(160))).toBe(1); // é is in GSM-7
    expect(smsSegments("🚪".repeat(35))).toBe(1);
    expect(smsSegments("日".repeat(71))).toBe(2);
  });
  it("round-trips Twilio and Slack signatures", async () => {
    const sig = await twilioSignature("tok", "https://x/y?a=1", { b: "2", a: "1" });
    expect(await verifyTwilioSignature("tok", "https://x/y?a=1", { a: "1", b: "2" }, sig)).toBe(true);
    expect(await verifyTwilioSignature("tok", "https://x/y?a=1", { a: "1", b: "3" }, sig)).toBe(false);
    const ts = String(Math.floor(Date.now() / 1000));
    const s = `v0=${await hmacSha256Hex("sec", `v0:${ts}:body`)}`;
    expect(await verifySlackSignature("sec", "body", ts, s)).toBe(true);
    expect(await verifySlackSignature("sec", "body", "1", s)).toBe(false);
  });
  it("builds TwiML with a DTMF ack gather and escapes text", () => {
    const x = voiceTwiml("Fire <alarm> & smoke", "https://s/ack?a=1&b=2");
    expect(x).toContain("Fire &lt;alarm&gt; &amp; smoke");
    expect(x).toContain('action="https://s/ack?a=1&amp;b=2"');
  });
});

describe("webhook endpoints, subscriptions, and queued delivery", () => {
  it("delivers a signed webhook, settles the reservation, and records the trace", async () => {
    const a = await bootstrap("webby", 1);
    await publish("@webby/alerts", "init", auth(a.token));
    const ep = await json<{ id: string; secret: string; verified: boolean }>(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/in" }) }));
    expect(ep.verified).toBe(true);
    expect(ep.secret).toMatch(/^whsec_/);
    const sub = await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@webby/alerts", endpoint_id: ep.id }) });
    expect(sub.status).toBe(201);

    const dry = await json<{ plan: { transport: string }[] }>(await publish("@webby/alerts", "x", auth(a.token, { "X-Dry-Run": "1" })));
    expect(dry.plan.map((d) => d.transport)).toEqual(["webhook"]);

    const before = await balance(a.token);
    const msg = await json<{ id: string }>(await publish("@webby/alerts", "door opened", auth(a.token, { "X-Title": "Door" })));
    const reservedAfterPublish = await balance(a.token);
    expect(reservedAfterPublish).toBeLessThan(before);

    // Pull the job the TopicDO queued and run the consumer against a stubbed provider.
    const calls = stubProviders(() => new Response("ok"));
    const job: DeliveryJob = { topic: "@webby/alerts", owner: a.account_id, message: { topic: "@webby/alerts", id: msg.id, message: "door opened", title: "Door" }, sub: { id: "x", transport: "webhook", endpoint: ep.id }, reservation: { ref: `dlv:${msg.id}:${JSON.parse(await sub.clone().text().catch(() => "{}")).id ?? ""}`, micros: 10 }, attempt: 0 };
    const subs = await json<{ subscriptions: { id: string }[] }>(await SELF.fetch(`${BASE}/v1/subscriptions`, { headers: auth(a.token) }));
    job.sub.id = subs.subscriptions[0]!.id;
    job.reservation.ref = `dlv:${msg.id}:${job.sub.id}`;
    job.reservation.micros = 10_000;
    expect(await processJob(job, E)).toBe("delivered");
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    const t = /t=(\d+)/.exec(headers["x-subetha-signature"]!)![1]!;
    expect(headers["x-subetha-signature"]).toBe(await signWebhook(ep.secret, calls[0]!.init.body as string, Number(t)));

    const trace = await json<{ events: { result: string; transport: string }[] }>(await SELF.fetch(`${BASE}/v1/traces/${msg.id}?topic=@webby/alerts`, { headers: auth(a.token) }));
    expect(trace.events.at(-1)).toMatchObject({ result: "delivered", transport: "webhook" });
  });

  it("releases the reservation on permanent failure and retries transient ones via the queue handler", async () => {
    const a = await bootstrap("flaky", 1);
    await publish("@flaky/t", "init", auth(a.token));
    const ep = await json<{ id: string }>(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/flaky" }) }));
    const { reserve } = await import("./reserve.ts");
    const ref = await reserve(E, a.account_id, 5000);
    const before = await balance(a.token);
    stubProviders(() => new Response("nope", { status: 404 }));
    const job: DeliveryJob = { topic: "@flaky/t", owner: a.account_id, message: { topic: "@flaky/t", id: "01JD0000000000000000000099", message: "x" }, sub: { id: "s", transport: "webhook", endpoint: ep.id }, reservation: { ref, micros: 5000 }, attempt: 0 };
    expect(await processJob(job, E)).toBe("failed");
    expect(await balance(a.token)).toBe(before + 5000);

    const ref2 = await reserve(E, a.account_id, 5000);
    stubProviders(() => new Response("busy", { status: 503 }));
    const batch = createMessageBatch("subetha-delivery-local", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { ...job, reservation: { ref: ref2, micros: 5000 } } }]);
    const ctx = createExecutionContext();
    await worker.queue(batch as MessageBatch<DeliveryJob>, E, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m1"]);
  });

  it("only lets topic owners subscribe endpoints", async () => {
    const a = await bootstrap("owner1");
    const b = await bootstrap("other1");
    await publish("@owner1/t", "init", auth(a.token));
    const ep = await json<{ id: string }>(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(b.token), body: JSON.stringify({ kind: "webhook", address: "https://h.example.com/x" }) }));
    const r = await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(b.token), body: JSON.stringify({ topic: "@owner1/t", endpoint_id: ep.id }) });
    expect(r.status).toBe(403);
  });
});

describe("verified paid endpoints", () => {
  it("emails a code (charged), rejects wrong codes, and verifies", async () => {
    const a = await bootstrap("mailer", 1);
    const calls = stubProviders(() => new Response(JSON.stringify({ MessageId: "m-1" })));
    const before = await balance(a.token);
    const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "email", address: "me@example.com" }) });
    expect(r.status).toBe(201);
    const ep = await json<{ id: string; verified: boolean; address: string }>(r);
    expect(ep.verified).toBe(false);
    expect(ep.address).toBe("m…@example.com");
    expect(calls[0]!.url).toContain("email.us-east-1.amazonaws.com");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(await balance(a.token)).toBeLessThan(before);
    const code = /code is (\d{6})/.exec(JSON.parse(calls[0]!.init.body as string).Content.Simple.Body.Text.Data)![1];
    expect((await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}/verify`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ code: "000000" === code ? "111111" : "000000" }) })).status).toBe(403);
    const ok = await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}/verify`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ code }) });
    expect(((await ok.json()) as { verified: boolean }).verified).toBe(true);
  });

  it("rejects unsupported and non-opted-in numbers and sends SMS codes via Twilio", async () => {
    const a = await bootstrap("texter", 1);
    // Outside the US only after opting in (destinations.test.ts); premium-rate never.
    expect((await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "sms", address: "+447700900123" }) })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "sms", address: "+19005550123" }) })).status).toBe(400);
    const calls = stubProviders(() => new Response(JSON.stringify({ sid: "SM1", num_segments: "1" }), { status: 201 }));
    const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "sms", address: "+14155550123" }) });
    expect(r.status).toBe(201);
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    expect(String(calls[0]!.init.body)).toContain("To=%2B14155550123");
  });

  it("refuses to send codes the account can't pay for", async () => {
    const a = await bootstrap("pennyless", 0);
    stubProviders(() => new Response("{}"));
    const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "email", address: "x@example.com" }) });
    expect(r.status).toBe(402);
    const list = await json<{ endpoints: unknown[] }>(await SELF.fetch(`${BASE}/v1/endpoints`, { headers: auth(a.token) }));
    expect(list.endpoints).toHaveLength(0);
  });
});

describe("inbound hooks", () => {
  it("handles Slack url_verification and rejects bad signatures", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${await hmacSha256Hex("slack-secret", `v0:${ts}:${body}`)}`;
    const r = await SELF.fetch(`${BASE}/v1/hooks/slack/events`, { method: "POST", body, headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig } });
    expect(await r.json()).toEqual({ challenge: "abc" });
    expect((await SELF.fetch(`${BASE}/v1/hooks/slack/events`, { method: "POST", body, headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=00" } })).status).toBe(401);
  });

  it("rejects Twilio hooks without a valid signature", async () => {
    const r = await SELF.fetch(`${BASE}/v1/hooks/twilio/sms`, { method: "POST", body: new URLSearchParams({ From: "+14155550123", Body: "hi" }) });
    expect(r.status).toBe(401);
  });
});

describe("Twilio SMS keywords", () => {
  it("answers HELP and handles STOP with valid signatures", async () => {
    const send = async (body: string) => {
      const params = { From: "+14155550199", Body: body, MessageSid: `SM${Math.random()}` };
      const sig = await twilioSignature("twilio-token", "http://localhost:8787/v1/hooks/twilio/sms", params);
      return SELF.fetch(`${BASE}/v1/hooks/twilio/sms`, { method: "POST", body: new URLSearchParams(params), headers: { "x-twilio-signature": sig } });
    };
    const help = await send("HELP");
    expect(help.status).toBe(200);
    expect(await help.text()).toContain("Reply STOP to opt out");
    expect((await send("STOP")).status).toBe(200);
  });
});

describe("Twilio price check (daily cron)", () => {
  const twilio = (sms: string[], voice: string[]) =>
    stubProviders((url) => {
      if (url.endsWith("/Messaging/Countries/US")) return Response.json({ outbound_sms_prices: [{ carrier: "x", prices: sms.map((p) => ({ number_type: "local", current_price: p })) }] });
      if (url.endsWith("/Voice/Countries/US")) return Response.json({ outbound_prefix_prices: voice.map((p) => ({ prefixes: ["1"], current_price: p })) });
      return new Response("not found", { status: 404 });
    });
  const prices = PRICES as unknown as PriceTable;

  it("derives each provider ceiling from the price table's margin floor", () => {
    const sms = providerCeilingUsd(prices.skus.deliver_sms_us!, "twilio");
    // At the ceiling, the cheapest tier keeps exactly the minimum margin.
    const s = prices.skus.deliver_sms_us!;
    const cheapest = Math.min(...Object.values(s.price_nanos));
    const cost = s.cost_nanos - s.components_nanos.twilio! + sms * 1e9;
    expect((cheapest - cost) / cheapest).toBeCloseTo(prices.min_margin, 6);
    expect(sms).toBeGreaterThan(s.components_nanos.twilio! / 1e9); // today's assumption fits
    expect(providerCeilingUsd(prices.skus.deliver_voice_us!, "twilio")).toBeGreaterThan(prices.skus.deliver_voice_us!.components_nanos.twilio! / 1e9);
  });

  it("opens the telephony circuit when SMS or voice costs more than prices absorb, and closes it after", async () => {
    await E.CACHE.delete(CIRCUIT_KEY);
    twilio(["0.0079", "0.0083"], ["0.0140"]);
    await checkTwilioPrices(E);
    expect(await E.CACHE.get(CIRCUIT_KEY)).toBeNull();
    expect(await E.CACHE.get("twilio:us:voice:max_usd")).toBe("0.014");

    twilio(["0.0083"], ["0.0140", "0.0300"]);
    await checkTwilioPrices(E);
    expect(await E.CACHE.get(CIRCUIT_KEY)).toMatch(/voice 0\.03 >/);

    twilio([], ["0.0140"]); // no SMS price: unknown destinations are not served
    await checkTwilioPrices(E);
    expect(await E.CACHE.get(CIRCUIT_KEY)).toMatch(/SMS price unknown/);

    twilio(["0.0083"], ["0.0140"]);
    await checkTwilioPrices(E);
    expect(await E.CACHE.get(CIRCUIT_KEY)).toBeNull();
  });

  it("leaves the circuit alone when Twilio can't be reached", async () => {
    await E.CACHE.put(CIRCUIT_KEY, "open: earlier");
    stubProviders(() => new Response("down", { status: 503 }));
    await checkTwilioPrices(E);
    expect(await E.CACHE.get(CIRCUIT_KEY)).toBe("open: earlier");
    await E.CACHE.delete(CIRCUIT_KEY);
  });
});
