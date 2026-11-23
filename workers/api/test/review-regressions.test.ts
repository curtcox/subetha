import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const post = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}/`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });

describe("review regressions", () => {
  it("rejects client times that would make retention charges negative or unbounded", async () => {
    const a = await bootstrap("neg");
    await publish("@neg/x", "init", auth(a.token));
    const now = Math.floor(Date.now() / 1000);
    expect((await post(a.token, { topic: "@neg/x", message: "evil", time: 9_000_000_000_000, expires: 0 })).status).toBe(400);
    expect((await post(a.token, { topic: "@neg/x", message: "old", time: now - 30 * 86400 })).status).toBe(400);
    expect((await post(a.token, { topic: "@neg/x", message: "expired", expires: now - 1 })).status).toBe(400);
    const ok = await json(await post(a.token, { topic: "@neg/x", message: "ok", expires: now + 10 * 365 * 86400 }));
    expect(ok.expires as number).toBeLessThanOrEqual(now + 12 * 3600 + 5);
  });

  it("ignores unsigned sender claims for allowed_publishers", async () => {
    const a = await bootstrap("allow");
    const dev = "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena";
    await SELF.fetch(`${BASE}/v1/topics/@allow/x`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { allowed_publishers: [dev] } }) });
    expect((await post(null, { topic: "@allow/x", message: "spoof", sender: dev })).status).toBe(400);
    expect((await post(null, { topic: "@allow/x", message: "anon" })).status).toBe(403);
  });

  it("caps an owner's token on delivery costs it causes, not just the publish", async () => {
    const a = await bootstrap("capped", 5);
    await publish("@capped/x", "init", auth(a.token));
    const ep = await json(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/c" }) }));
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@capped/x", endpoint_id: ep.id }) });
    const t = await json(await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ scopes: ["publish:@capped/x"], daily_cap_usd: 0.00002 }) }));
    expect((await publish("@capped/x", "1", auth(t.token as string))).status).toBe(200); // 6 + 10 µ$
    const second = await publish("@capped/x", "2", auth(t.token as string));
    expect(second.status).toBe(403);
    expect((await json(second)).error).toBe("spend_cap_exceeded");
  });

  it("never drops live deliveries to meet a max cost (they're broadcast anyway)", async () => {
    const a = await bootstrap("maxc");
    await publish("@maxc/x", "init", auth(a.token));
    const sub = await SELF.fetch(`${BASE}/@maxc/x/json`, { headers: auth(a.token) });
    const dry = await json(await publish("@maxc/x", "x", auth(a.token, { "X-Dry-Run": "1", "X-Max-Cost": "0" })));
    expect((dry.plan as unknown[]).length).toBe(1);
    await sub.body!.cancel();
  });

  it("applies tag filters to endpoint subscriptions", async () => {
    const a = await bootstrap("tagf", 5);
    await publish("@tagf/x", "init", auth(a.token));
    const ep = await json(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/t" }) }));
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@tagf/x", endpoint_id: ep.id, filter: { tags: ["alarm"] } }) });
    const plain = await json(await publish("@tagf/x", "x", auth(a.token, { "X-Dry-Run": "1" })));
    expect(plain.plan).toEqual([]);
    const tagged = await json(await publish("@tagf/x", "x", auth(a.token, { "X-Dry-Run": "1", "X-Tags": "alarm,x" })));
    expect((tagged.plan as unknown[]).length).toBe(1);
  });

  it("refuses anonymous dry runs", async () => {
    const a = await bootstrap("anondry");
    await SELF.fetch(`${BASE}/v1/topics/@anondry/x`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { public_publish: true } }) });
    expect((await publish("@anondry/x", "x", { "X-Dry-Run": "1" })).status).toBe(401);
  });
});

import { env } from "cloudflare:test";
import { vi } from "vitest";
import { processJob } from "../src/delivery/consumer.ts";
import { twilioSignature } from "../src/delivery/twilio.ts";
import { parseEmail } from "../src/email-inbound.ts";
import { meterRent } from "../src/cron.ts";
import { signStripePayload } from "../src/stripe.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { balance } from "./helpers.ts";
import { reserve } from "./reserve.ts";

const E = env as unknown as Env;
const stripe = async (evt: unknown) => {
  const payload = JSON.stringify(evt);
  return SELF.fetch(`${BASE}/v1/hooks/stripe`, { method: "POST", body: payload, headers: { "stripe-signature": await signStripePayload(payload, "whsec_test") } });
};

describe("review regressions, batch 2", () => {
  it("keeps account data and topic names away from non-admin tokens", async () => {
    const a = await bootstrap("leak");
    await publish("t_" + "q".repeat(26), "secret", auth(a.token));
    const t = await json(await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ scopes: ["publish:@leak/door"] }) }));
    for (const path of ["/v1/topics", "/v1/account", "/v1/balance", "/v1/ledger", "/v1/endpoints", "/v1/subscriptions", "/v1/devices"]) {
      expect((await SELF.fetch(`${BASE}${path}`, { headers: auth(t.token as string) })).status, path).toBe(403);
    }
  });

  it("rejects unknown Authorization schemes instead of treating them as anonymous", async () => {
    expect((await SELF.fetch(`${BASE}/v1/topics`, { headers: { authorization: "Foo abc" } })).status).toBe(401);
  });

  it("enforces the account kill switch", async () => {
    const a = await bootstrap("killed");
    await publish("@killed/x", "init", auth(a.token));
    await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: true }) });
    expect((await publish("@killed/x", "after", auth(a.token))).status).toBe(403);
    await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: false }) });
    expect((await publish("@killed/x", "back", auth(a.token))).status).toBe(200);
  });

  it("recovers disputes once and deducts only newly refunded amounts", async () => {
    const a = await bootstrap("refundee", 0);
    await stripe({ id: "evt_r1", type: "checkout.session.completed", data: { object: { id: "cs_r1", payment_intent: "pi_r1", payment_status: "paid", amount_total: 5000, metadata: { account_id: a.account_id } } } });
    const start = await balance(a.token);
    await stripe({ id: "evt_r2", type: "charge.refunded", data: { object: { payment_intent: "pi_r1", amount: 5000, amount_refunded: 1000 } } });
    await stripe({ id: "evt_r3", type: "charge.refunded", data: { object: { payment_intent: "pi_r1", amount: 5000, amount_refunded: 1500 } } });
    expect(await balance(a.token)).toBe(start - 15_000_000);
    await stripe({ id: "evt_r4", type: "charge.dispute.created", data: { object: { payment_intent: "pi_r1", amount: 1000 } } });
    await stripe({ id: "evt_r5", type: "charge.dispute.created", data: { object: { payment_intent: "pi_r1", amount: 1000 } } });
    expect(await balance(a.token)).toBe(Math.max(0, start - 15_000_000 - 10_000_000 - 15_000_000));
  });

  it("never re-sends a delivery that already went out", async () => {
    const a = await bootstrap("resend", 1);
    await publish("@resend/x", "init", auth(a.token));
    const ep = await json(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/r" }) }));
    let sends = 0;
    const real = globalThis.fetch;
    // Count only the webhook's own host: background work from other tests can fetch elsewhere.
    vi.stubGlobal("fetch", async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = String(i instanceof Request ? i.url : i);
      if (url.startsWith(BASE)) return real(i, init);
      if (url.startsWith("https://hooks.example.com/r")) sends++;
      return new Response("ok");
    });
    const ref = await reserve(E, a.account_id, 1000);
    const job: DeliveryJob = { topic: "@resend/x", owner: a.account_id, message: { topic: "@resend/x", id: "01JD0000000000000000000077", message: "x" }, sub: { id: "s", transport: "webhook", endpoint: ep.id as string }, reservation: { ref, micros: 1000 }, attempt: 0 };
    expect(await processJob(job, E)).toBe("delivered");
    expect(await processJob({ ...job, attempt: 1 }, E)).toBe("delivered");
    expect(sends).toBe(1);
    vi.unstubAllGlobals();
  });

  it("rejects webhook IP literals and bare publishable scopes", async () => {
    const a = await bootstrap("hard");
    for (const address of ["https://10.0.0.1/x", "https://[::1]/x", "https://subetha.us./x", "https://intranet/x"]) {
      expect((await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address }) })).status, address).toBe(400);
    }
    const r = await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ scopes: ["publish"], origins: ["https://example.com"], daily_cap_usd: 1 }) });
    expect(r.status).toBe(400);
  });

  it("deletes topic attachments from R2 and D1 when a topic is deleted", async () => {
    const a = await bootstrap("delatt", 1);
    const up = await SELF.fetch(`${BASE}/@delatt/x`, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3, 4]),
      headers: auth(a.token, { "X-Filename": "snap.bin", "content-type": "application/octet-stream" }),
    });
    expect(up.status).toBe(200);
    const msg = (await up.json()) as { attachment: { url: string } };
    const path = new URL(msg.attachment.url).pathname;
    expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(200);

    expect((await SELF.fetch(`${BASE}/v1/topics/@delatt/x`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(404);
    const row = await E.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE topic = '@delatt/x'").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("enforces read permissions on GET /{topics}/auth", async () => {
    const a = await bootstrap("authchk", 1);
    const b = await bootstrap("authother", 1);
    await SELF.fetch(`${BASE}/v1/topics/@authchk/priv`, { method: "PUT", headers: auth(a.token), body: "{}" });
    await SELF.fetch(`${BASE}/v1/topics/@authchk/pub`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { public_read: true } }) });

    expect((await SELF.fetch(`${BASE}/@authchk/priv/auth`)).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/@authchk/priv/auth`, { headers: auth(b.token) })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/@authchk/priv/auth`, { headers: auth(a.token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/@authchk/pub/auth`)).status).toBe(200);
  });

  it("enforces token spend caps and account pause on /v1/keys", async () => {
    const a = await bootstrap("keycap", 1);
    await SELF.fetch(`${BASE}/v1/topics/@keycap/v`, { method: "PUT", headers: auth(a.token), body: "{}" });
    const t = await json(await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ scopes: ["admin"], daily_cap_usd: 0.000001 }) }));
    const r = await SELF.fetch(`${BASE}/v1/keys`, { headers: auth(t.token as string) });
    expect(r.status).toBe(403);
    expect((await json(r)).error).toBe("spend_cap_exceeded");

    await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: true }) });
    const paused = await SELF.fetch(`${BASE}/v1/keys`, { headers: auth(a.token) });
    expect(paused.status).toBe(403);
    expect((await json(paused)).error).toBe("topic_paused");
  });

  it("STOP re-syncs all matching sms/voice topics and ACK stops voice escalation across endpoints", async () => {
    const a = await bootstrap("stopall", 5);
    await SELF.fetch(`${BASE}/v1/topics/@stopall/sms`, { method: "PUT", headers: auth(a.token), body: "{}" });
    await SELF.fetch(`${BASE}/v1/topics/@stopall/voice`, { method: "PUT", headers: auth(a.token), body: "{}" });
    const phone = "+14155550199";
    const now = Date.now();
    await E.DB.batch([
      E.DB.prepare("INSERT INTO endpoints (id, account_id, kind, address, config, verified_at, created_at) VALUES ('ep_sms_stop', ?, 'sms', ?, '{}', ?, ?)").bind(a.account_id, phone, now, now),
      E.DB.prepare("INSERT INTO endpoints (id, account_id, kind, address, config, verified_at, created_at) VALUES ('ep_voice_stop', ?, 'voice', ?, '{}', ?, ?)").bind(a.account_id, phone, now, now),
    ]);
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@stopall/sms", endpoint_id: "ep_sms_stop" }) });
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@stopall/voice", endpoint_id: "ep_voice_stop" }) });

    // Confirm both topics currently plan deliveries to those endpoints.
    expect(((await json(await publish("@stopall/sms", "hi", auth(a.token, { "X-Dry-Run": "1" })))).plan as unknown[]).length).toBe(1);
    expect(((await json(await publish("@stopall/voice", "hi", auth(a.token, { "X-Dry-Run": "1" })))).plan as unknown[]).length).toBe(1);

    // Send ACK for a voice-topic message via SMS from the same number.
    const msg = await json(await publish("@stopall/voice", "alarm", auth(a.token, { "X-Dry-Run": "0" })));
    const postTwilio = async (params: Record<string, string>) => {
      const sigUrl = `${E.BASE_URL}/v1/hooks/twilio/sms`;
      const sig = await twilioSignature(E.TWILIO_AUTH_TOKEN!, sigUrl, params);
      return SELF.fetch(`${BASE}/v1/hooks/twilio/sms`, { method: "POST", headers: { "x-twilio-signature": sig, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    };
    expect((await postTwilio({ From: phone, Body: `ACK ${msg.id as string}`, MessageSid: "SM_ack_1" })).status).toBe(200);
    const trace = await json(await SELF.fetch(`${BASE}/v1/traces/${msg.id as string}?topic=${encodeURIComponent("@stopall/voice")}`, { headers: auth(a.token) }));
    expect((trace.ack as { via: string } | null)?.via).toBe("sms");

    // STOP must unverify AND sync both @stopall/sms and @stopall/voice so neither plans deliveries.
    expect((await postTwilio({ From: phone, Body: "STOP", MessageSid: "SM_stop_1" })).status).toBe(200);
    expect(((await json(await publish("@stopall/sms", "after", auth(a.token, { "X-Dry-Run": "1" })))).plan as unknown[]).length).toBe(0);
    expect(((await json(await publish("@stopall/voice", "after", auth(a.token, { "X-Dry-Run": "1" })))).plan as unknown[]).length).toBe(0);
  });

  it("extracts text from single-part text/html inbound emails", () => {
    const raw = [
      "From: alerts@example.com",
      "Subject: Disk full",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><h1>Alert</h1><p>Disk is <b>98%</b> full.</p></body></html>",
    ].join("\r\n");
    const parsed = parseEmail(raw);
    expect(parsed.subject).toBe("Disk full");
    expect(parsed.text).toBe("Alert Disk is 98% full.");
  });

  it("deletes account attachments when frozen grace period expires", async () => {
    const a = await bootstrap("frozatt", 0.01);
    const up = await SELF.fetch(`${BASE}/@frozatt/x`, {
      method: "PUT",
      body: new Uint8Array([9, 8, 7]),
      headers: auth(a.token, { "X-Filename": "f.bin", "content-type": "application/octet-stream" }),
    });
    expect(up.status).toBe(200);
    const msg = (await up.json()) as { attachment: { url: string } };
    const path = new URL(msg.attachment.url).pathname;

    // Give the account an endpoint, drain its balance, and set frozen_since > 30 days ago.
    await E.DB.prepare("INSERT INTO endpoints (id, account_id, kind, address, config, verified_at, created_at) VALUES ('ep_froz', ?, 'webhook', 'https://hooks.example.com/f', '{}', ?, ?)").bind(a.account_id, Date.now(), Date.now()).run();
    const cur = await balance(a.token);
    await E.ACCOUNT.get(E.ACCOUNT.idFromName(a.account_id)).adjust(-cur, "drain:frozatt", "test");
    const longAgo = Date.now() - 31 * 86_400_000;
    await E.DB.prepare("UPDATE accounts SET frozen_since = ? WHERE id = ?").bind(longAgo, a.account_id).run();

    await meterRent(E, Date.now());
    expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(404);
    const row = await E.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE owner_account_id = ?").bind(a.account_id).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
