// Analytics Engine telemetry (PLAN §7) and global / per-account telephony circuit breakers (PLAN §8).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountCircuitKey, checkProviderDivergence, checkTelephonyCircuit, CIRCUIT_KEY, tripAccountTelephonyCircuit } from "../src/cron.ts";
import { processJob } from "../src/delivery/consumer.ts";
import { hmacSha256Hex } from "../src/crypto.ts";
import { emitMetric, estimatedCostMicros } from "../src/telemetry.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";
import { reserve } from "./reserve.ts";

const E = env as unknown as Env;
const realFetch = globalThis.fetch;

afterEach(async () => {
  vi.unstubAllGlobals();
  await E.CACHE.delete(CIRCUIT_KEY);
});

describe("Analytics Engine telemetry (PLAN §7)", () => {
  it("writes structured data points and never throws when the dataset fails", () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const envOk = { ...E, ANALYTICS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) } } as unknown as Env;
    emitMetric(envOk, {
      accountId: "acct_test",
      event: "delivery",
      transport: "webhook",
      sku: "deliver_webhook",
      outcome: "delivered",
      revenueMicros: 10,
      providerCostMicros: estimatedCostMicros("deliver_webhook"),
      units: 1,
      latencyMs: 42,
    });
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      indexes: ["acct_test"],
      blobs: ["delivery", "webhook", "deliver_webhook", "delivered", ""],
      doubles: [10, estimatedCostMicros("deliver_webhook"), 1, 42],
    });
    expect(estimatedCostMicros("deliver_webhook")).toBeGreaterThan(0);

    const envBad = { ...E, ANALYTICS: { writeDataPoint: () => { throw new Error("boom"); } } } as unknown as Env;
    expect(() => emitMetric(envBad, { accountId: "acct_test", event: "publish" })).not.toThrow();
  });

  it("emits delivery telemetry from processJob", async () => {
    const a = await bootstrap("telem", 2);
    await publish("@telem/box", "init", auth(a.token));
    const ep = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/telem" }),
    })).json()) as { id: string };
    const points: AnalyticsEngineDataPoint[] = [];
    const envWithAnalytics = { ...E, ANALYTICS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) } } as unknown as Env;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(BASE)) return realFetch(input, init);
      return new Response("ok", { status: 200 });
    });
    const job: DeliveryJob = {
      topic: "@telem/box", owner: a.account_id,
      message: { topic: "@telem/box", id: "01JD00000000000000000000T1", message: "hi" },
      sub: { id: "s1", transport: "webhook", endpoint: ep.id },
      reservation: { ref: await reserve(E, a.account_id, 10), micros: 10 },
      attempt: 0,
      sku: "deliver_webhook",
    };
    expect(await processJob(job, envWithAnalytics)).toBe("delivered");
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs).toEqual(["delivery", "webhook", "deliver_webhook", "delivered", ""]);
    expect(points[0]!.doubles![0]).toBe(10);
  });
});

describe("global and per-account telephony circuit breakers (PLAN §8)", () => {
  it("trips the global circuit when Twilio spend diverges above metered revenue", async () => {
    const now = Date.UTC(2026, 10, 20, 3, 17);
    const yestNoon = Date.UTC(2026, 10, 19, 12, 0);
    // Record $1.00 of metered delivery revenue yesterday in ledger_journal.
    await E.DB.prepare(
      "INSERT INTO ledger_journal (account_id, seq, kind, amount, ref, available_after, reserved_after, time) VALUES (?, ?, 'reserve', ?, 'dlv:yest:1', 0, 0, ?)",
    ).bind("acct_div", 1, -1_000_000, yestNoon).run();

    const envTwilio = { ...E, TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok" } as Env;
    // Healthy margin: Twilio billed $0.50 against $1.00 revenue -> stays closed.
    vi.stubGlobal("fetch", async () => Response.json({ usage_records: [{ category: "totalprice", price: "0.50" }] }));
    const ok = await checkProviderDivergence(envTwilio, now);
    expect(ok).toEqual({ tripped: false, twilioMicros: 500_000, revenueMicros: 1_000_000 });
    expect(await E.CACHE.get(CIRCUIT_KEY)).toBeNull();

    // Diverged: Twilio billed $2.00 against $1.00 revenue -> trips global breaker.
    vi.stubGlobal("fetch", async () => Response.json({ usage_records: [{ category: "totalprice", price: "2.00" }] }));
    const bad = await checkProviderDivergence(envTwilio, now);
    expect(bad?.tripped).toBe(true);
    const reason = await E.CACHE.get(CIRCUIT_KEY);
    expect(reason).toContain("provider spend divergence");
  });

  it("isolates per-account circuit breakers and trips on Stripe chargeback", async () => {
    const a = await bootstrap("cbacct1", 5);
    const b = await bootstrap("cbacct2", 5);
    await publish("@cbacct1/a", "init", auth(a.token));
    await publish("@cbacct2/b", "init", auth(b.token));

    // Seed a verified SMS endpoint for each account.
    const seedSms = async (accountId: string, id: string, phone: string) => {
      await E.DB.prepare("INSERT INTO endpoints (id, account_id, kind, address, config, verified_at, created_at) VALUES (?, ?, 'sms', ?, '{}', ?, ?)")
        .bind(id, accountId, phone, Date.now(), Date.now()).run();
    };
    await seedSms(a.account_id, "ep_cba", "+14155550101");
    await seedSms(b.account_id, "ep_cbb", "+14155550102");

    // Trip per-account circuit for A only.
    await tripAccountTelephonyCircuit(E, a.account_id, "test anomaly");
    expect(await checkTelephonyCircuit(E, a.account_id)).toContain("test anomaly");
    expect(await checkTelephonyCircuit(E, b.account_id)).toBeNull();

    // GET /v1/account exposes telephony_circuit for A, null for B.
    const acctA = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { telephony_circuit: string | null };
    const acctB = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(b.token) })).json()) as { telephony_circuit: string | null };
    expect(acctA.telephony_circuit).toContain("test anomaly");
    expect(acctB.telephony_circuit).toBeNull();

    // Delivery for A fails permanently without calling Twilio; B succeeds.
    const envTwilio = { ...E, TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+14155550199" } as Env;
    const smsCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(BASE)) return realFetch(input, init);
      smsCalls.push(url);
      return Response.json({ sid: "SM123", num_segments: "1" }, { status: 201 });
    });

    const jobA: DeliveryJob = {
      topic: "@cbacct1/a", owner: a.account_id,
      message: { topic: "@cbacct1/a", id: "01JD00000000000000000000C1", message: "blocked" },
      sub: { id: "sa", transport: "sms", endpoint: "ep_cba" },
      reservation: { ref: await reserve(E, a.account_id, 20_000), micros: 20_000 }, attempt: 0, sku: "deliver_sms_us",
    };
    expect(await processJob(jobA, envTwilio)).toBe("failed");
    expect(smsCalls).toHaveLength(0);

    const jobB: DeliveryJob = {
      topic: "@cbacct2/b", owner: b.account_id,
      message: { topic: "@cbacct2/b", id: "01JD00000000000000000000C2", message: "allowed" },
      sub: { id: "sb", transport: "sms", endpoint: "ep_cbb" },
      reservation: { ref: await reserve(E, b.account_id, 20_000), micros: 20_000 }, attempt: 0, sku: "deliver_sms_us",
    };
    expect(await processJob(jobB, envTwilio)).toBe("delivered");
    expect(smsCalls).toHaveLength(1);

    // Stripe charge.dispute.created automatically trips B's per-account telephony circuit!
    await E.DB.prepare("INSERT INTO stripe_payments (payment_intent, account_id, amount_micros, fee_micros, kind, created_at) VALUES (?, ?, 5000000, 575000, 'checkout', ?)")
      .bind("pi_disp_1", b.account_id, Date.now()).run();
    const evt = JSON.stringify({ id: "evt_disp_cb", type: "charge.dispute.created", data: { object: { payment_intent: "pi_disp_1", amount: 500 } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=${await hmacSha256Hex(E.STRIPE_WEBHOOK_SECRET!, `${ts}.${evt}`)}`;
    const hook = await SELF.fetch(`${BASE}/v1/hooks/stripe`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: evt });
    expect(hook.status).toBe(200);
    expect(await E.CACHE.get(accountCircuitKey(b.account_id))).toContain("chargeback dispute");
  });
});
