// Regressions for the Phase 3 security review (spend caps, replay, idempotency, races).
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { enrollmentProof } from "@subetha/sdk";
import { deviceKeyFromSeed, hexDecode, signEnvelope, ulid } from "@subetha/sdk/protocol";
import { describe, expect, it } from "vitest";
import { accountStub } from "../src/durable/account.ts";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const put = (token: string, topic: string, policy: Record<string, unknown>) =>
  SELF.fetch(`${BASE}/v1/topics/${topic}`, { method: "PUT", headers: auth(token), body: JSON.stringify({ policy }) });
async function webhookSub(token: string, topic: string) {
  const ep = await json(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(token), body: JSON.stringify({ kind: "webhook", address: `https://hooks.example.com/${ulid()}` }) }));
  await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(token), body: JSON.stringify({ topic, endpoint_id: ep.id }) });
}

describe("security review", () => {
  it("counts queued deliveries against the anonymous daily cap", async () => {
    const a = await bootstrap("anoncap", 5);
    await publish("@anoncap/x", "init", auth(a.token));
    await put(a.token, "@anoncap/x", { public_publish: true, anon_daily_cap_micros: 25 });
    await webhookSub(a.token, "@anoncap/x");
    // publish 6 + webhook 10 + retention 1 = 17 µ$ per anonymous publish.
    expect((await publish("@anoncap/x", "1")).status).toBe(200);
    const second = await publish("@anoncap/x", "2");
    expect(second.status).toBe(403);
    expect((await json(second)).error).toBe("spend_cap_exceeded");
  });

  it("does not let concurrent publishes overrun the topic daily cap", async () => {
    const a = await bootstrap("race", 5);
    await publish("@race/x", "init", auth(a.token));
    await put(a.token, "@race/x", { daily_cap_micros: 30 });
    await webhookSub(a.token, "@race/x");
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => publish("@race/x", `m${i}`, auth(a.token))));
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThanOrEqual(3); // 10 µ$ of queued delivery each
  });

  it("applies token spend caps to reads", async () => {
    const a = await bootstrap("readcap", 5);
    await publish("@readcap/x", "one", auth(a.token));
    const t = await json(await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ scopes: ["subscribe:@readcap/x"], daily_cap_usd: 0.00001 }) }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await SELF.fetch(`${BASE}/@readcap/x/json?poll=1&since=all`, { headers: auth(t.token as string) })).status);
    // 3 µ$ per request + 2 µ$ per message: two polls fit in 10 µ$.
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.slice(2).every((s) => s === 403)).toBe(true);
    const stream = await SELF.fetch(`${BASE}/@readcap/x/json?since=all`, { headers: auth(t.token as string) });
    expect(stream.status).toBe(403);
  });

  it("charges for Idempotency-Key replays", async () => {
    const a = await bootstrap("idemc", 5);
    const h = auth(a.token, { "Idempotency-Key": "k1" });
    expect((await publish("@idemc/x", "once", h)).status).toBe(200);
    const again = await publish("@idemc/x", "once", h);
    expect(again.status).toBe(200);
    expect(again.headers.get("x-duplicate")).toBe("1");
    expect(Number(again.headers.get("x-cost-micros"))).toBeGreaterThan(0);
  });

  it("rejects a signed message replayed after it left storage", async () => {
    const a = await bootstrap("replay", 5);
    await publish("@replay/x", "init", auth(a.token));
    const key = await deviceKeyFromSeed(hexDecode("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"));
    const env0 = await signEnvelope({ id: ulid(), time: Math.floor(Date.now() / 1000), topic: "@replay/x", message: "alarm" }, key);
    const post = () => SELF.fetch(`${BASE}/`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify(env0) });
    expect((await post()).status).toBe(200);
    expect((await post()).headers.get("x-duplicate")).toBe("1"); // still stored: a normal duplicate
    const stub = E.TOPIC.get(E.TOPIC.idFromName("@replay/x"));
    await runInDurableObject(stub, async (_obj, state) => { state.storage.sql.exec("DELETE FROM messages"); });
    const replay = await post();
    expect(replay.status).toBe(409);
  });
});

describe("security review: devices", () => {
  const post = (path: string, body: unknown, token?: string) =>
    SELF.fetch(`${BASE}${path}`, { method: "POST", headers: token ? auth(token) : {}, body: JSON.stringify(body) });

  it("needs proof of key possession to register a device directly", async () => {
    const a = await bootstrap("devproof");
    const key = await deviceKeyFromSeed(new Uint8Array(32).fill(21));
    expect((await post("/v1/devices", { device_id: key.deviceId }, a.token)).status).toBe(400);
    const other = await deviceKeyFromSeed(new Uint8Array(32).fill(22));
    const forged = { ...(await enrollmentProof(other)), device_id: key.deviceId };
    expect((await post("/v1/devices", forged, a.token)).status).toBe(401);
    expect((await post("/v1/devices", { ...(await enrollmentProof(key)), capabilities: Array(40).fill("ws") }, a.token)).status).toBe(400);
    expect((await post("/v1/devices", await enrollmentProof(key), a.token)).status).toBe(201);
  });

  it("refuses to approve a code for a device another account holds", async () => {
    const owner = await bootstrap("devown");
    const other = await bootstrap("devother");
    const key = await deviceKeyFromSeed(new Uint8Array(32).fill(23));
    expect((await post("/v1/devices", await enrollmentProof(key), owner.token)).status).toBe(201);
    const code = await json(await post("/v1/device/code", await enrollmentProof(key)));
    const approve = await post("/v1/device/approve", { user_code: code.user_code }, other.token);
    expect(approve.status).toBe(409);
    const token = await json(await post("/v1/device/token", { device_code: code.device_code }));
    expect(token.error).toBe("authorization_pending");
  });

  it("keeps one pending code per device", async () => {
    const key = await deviceKeyFromSeed(new Uint8Array(32).fill(24));
    await post("/v1/device/code", await enrollmentProof(key));
    await post("/v1/device/code", await enrollmentProof(key));
    const n = await E.DB.prepare("SELECT COUNT(*) AS n FROM device_codes WHERE device_id = ?").bind(key.deviceId).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("security review: rent freeze", () => {
  it("stops delivering to a frozen account's endpoints and resumes after it pays", async () => {
    const { meterRent } = await import("../src/cron.ts");
    const a = await bootstrap("frozen", 0.00001); // 10 µ$: one day of endpoint rent, not two
    await SELF.fetch(`${BASE}/v1/topics/@frozen/x`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: {} }) });
    await webhookSub(a.token, "@frozen/x");
    const subs = async () => runInDurableObject(E.TOPIC.get(E.TOPIC.idFromName("@frozen/x")), async (_o, st) => st.storage.sql.exec("SELECT id FROM subs").toArray().length);
    expect(await subs()).toBe(1);
    for (let d = 1; d <= 20 && (await E.DB.prepare("SELECT frozen_since FROM accounts WHERE id = ?").bind(a.account_id).first<{ frozen_since: number | null }>())?.frozen_since == null; d++) {
      await meterRent(E, Date.UTC(2026, 7, d));
    }
    expect(await subs()).toBe(0);
    await accountStub(E, a.account_id).topup(5_000_000, "test-topup");
    await meterRent(E, Date.UTC(2026, 8, 1));
    expect(await subs()).toBe(1);
  });
});

describe("security review: web push endpoints", () => {
  it("rejects push subscriptions pointing at the relay, IPs or localhost", async () => {
    const a = await bootstrap("wpssrf");
    for (const endpoint of ["https://127.0.0.1/x", "https://localhost/x", "https://subetha.org/x"]) {
      const address = JSON.stringify({ endpoint, keys: { p256dh: "x", auth: "y" } });
      const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webpush", address }) });
      expect(r.status, endpoint).toBe(400);
    }
  });
});
