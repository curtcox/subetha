import { SELF } from "cloudflare:test";
import { enrollDevice } from "./dba.ts";
import { describe, expect, it } from "vitest";
import { enrollmentProof, signRequest } from "@subetha/sdk";
import { generateDeviceKey, utf8 } from "@subetha/sdk/protocol";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

describe("account and topic policies", () => {
  it("enforces account monthly_cap_micros on publishes", async () => {
    const a = await bootstrap("mcap", 5);
    const patch = await SELF.fetch(`${BASE}/v1/account`, {
      method: "PATCH",
      headers: auth(a.token),
      body: JSON.stringify({ monthly_cap_micros: 10 }),
    });
    expect(patch.status).toBe(200);
    const acct = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { monthly_cap_micros: number | null };
    expect(acct.monthly_cap_micros).toBe(10);

    // First publish costs ~5 µ$ (publish) + retention lease (<= 10 µ$ clamped by monthly cap).
    // With a 10 µ$ monthly cap, a burst of publishes hits spend_cap_exceeded (account_monthly).
    const r1 = await publish("@mcap/a", "one", auth(a.token));
    expect(r1.status).toBe(200);
    const r2 = await publish("@mcap/a", "two", auth(a.token));
    const r3 = await publish("@mcap/a", "three", auth(a.token));
    const blocked = [r2, r3].find((r) => r.status === 403);
    expect(blocked).toBeDefined();
    const body = (await blocked!.json()) as { error: string; cap?: string };
    expect(body.error).toBe("spend_cap_exceeded");
    expect(body.cap).toBe("account_monthly");

    // Clearing the cap allows publishes again.
    await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ monthly_cap_micros: null }) });
    expect((await publish("@mcap/a", "after", auth(a.token))).status).toBe(200);
  });

  it("enforces topic monthly_cap_micros on publishes and polls", async () => {
    const a = await bootstrap("tmcap", 5);
    const put = await SELF.fetch(`${BASE}/v1/topics/@tmcap/box`, {
      method: "PUT",
      headers: auth(a.token),
      body: JSON.stringify({ policy: { monthly_cap_micros: 5 } }),
    });
    expect(put.status).toBe(201);
    const ep = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/tmcap" }),
    })).json()) as { id: string };
    await SELF.fetch(`${BASE}/v1/subscriptions`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ topic: "@tmcap/box", endpoint_id: ep.id }),
    });
    // Webhook delivery costs 10 µ$ > topic monthly_cap_micros (5 µ$).
    const r = await publish("@tmcap/box", "hi", auth(a.token));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "spend_cap_exceeded", cap: "topic_monthly" });
  });

  it("intersects account allow_transports and deny_transports with topic policies", async () => {
    const a = await bootstrap("accttr", 5);
    await publish("@accttr/alerts", "init", auth(a.token));
    const hook = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/accttr" }),
    })).json()) as { id: string };
    const lxmf = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ kind: "lxmf", address: "0123456789abcdef0123456789abcdef" }),
    })).json()) as { id: string };
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@accttr/alerts", endpoint_id: hook.id }) });
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@accttr/alerts", endpoint_id: lxmf.id }) });

    // Baseline: both webhook and lxmf are planned.
    const before = (await (await publish("@accttr/alerts", "hi", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: { transport: string }[] };
    expect(before.plan.map((d) => d.transport).sort()).toEqual(["lxmf", "webhook"]);

    // Account denies webhook -> synced to existing topics immediately.
    const p1 = await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ deny_transports: ["webhook"] }) });
    expect(p1.status).toBe(200);
    const afterDeny = (await (await publish("@accttr/alerts", "hi", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: { transport: string }[] };
    expect(afterDeny.plan.map((d) => d.transport)).toEqual(["lxmf"]);

    // Account allow_transports restricts to webhook only (and clears deny_transports).
    const p2 = await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ allow_transports: ["webhook"], deny_transports: null }) });
    expect(p2.status).toBe(200);
    const acct = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { allow_transports: string[] | null; deny_transports: string[] | null };
    expect(acct.allow_transports).toEqual(["webhook"]);
    expect(acct.deny_transports).toBeNull();
    const afterAllow = (await (await publish("@accttr/alerts", "hi", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: { transport: string }[] };
    expect(afterAllow.plan.map((d) => d.transport)).toEqual(["webhook"]);

    // Newly auto-created topics inherit the account's transport policy too.
    await publish("@accttr/fresh", "init", auth(a.token));
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@accttr/fresh", endpoint_id: lxmf.id }) });
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@accttr/fresh", endpoint_id: hook.id }) });
    const freshPlan = (await (await publish("@accttr/fresh", "hi", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: { transport: string }[] };
    expect(freshPlan.plan.map((d) => d.transport)).toEqual(["webhook"]);
  });

  it("pauses/resumes devices and enforces per-device transport allow/deny policies", async () => {
    const a = await bootstrap("devpol", 5);
    await publish("@devpol/alerts", "init", auth(a.token));
    const hook = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/devpol" }),
    })).json()) as { id: string };
    const lxmf = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ kind: "lxmf", address: "fedcba9876543210fedcba9876543210" }),
    })).json()) as { id: string };
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@devpol/alerts", endpoint_id: hook.id }) });
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@devpol/alerts", endpoint_id: lxmf.id }) });

    const key = await generateDeviceKey();
    const proof = await enrollmentProof(key);
    const enrolled = await enrollDevice(a.account_id, key, { name: "sensor-1", capabilities: ["ws"] });
    expect(enrolled.status).toBe(201);

    const devReq = async (path: string, body: string, extra: Record<string, string> = {}) => {
      const url = `${BASE}${path}`;
      const baseHeaders: Record<string, string> = { "content-type": "text/plain", ...extra };
      const sig = await signRequest(key, "POST", url, utf8.encode(body), baseHeaders);
      return SELF.fetch(url, { method: "POST", headers: { ...baseHeaders, ...sig }, body });
    };

    // Active device can publish and sees both transports in dry-run plan.
    const r0 = await devReq("/@devpol/alerts", "ok", { "x-dry-run": "1" });
    expect(r0.status).toBe(200);
    expect(((await r0.json()) as { plan: { transport: string }[] }).plan.map((d) => d.transport).sort()).toEqual(["lxmf", "webhook"]);

    // Pause device (kill switch) -> rejected with 403 topic_paused.
    const paused = await SELF.fetch(`${BASE}/v1/devices/${key.deviceId}`, {
      method: "PATCH",
      headers: auth(a.token),
      body: JSON.stringify({ paused: true }),
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ id: key.deviceId, paused: true });
    const blocked = await devReq("/@devpol/alerts", "nope");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "topic_paused" });

    // Resume device and deny webhook -> only lxmf remains in plan.
    const resumed = await SELF.fetch(`${BASE}/v1/devices/${key.deviceId}`, {
      method: "PATCH",
      headers: auth(a.token),
      body: JSON.stringify({ paused: false, deny_transports: ["webhook"] }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ paused: false, deny_transports: ["webhook"] });
    const r1 = await devReq("/@devpol/alerts", "after-deny", { "x-dry-run": "1" });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { plan: { transport: string }[] }).plan.map((d) => d.transport)).toEqual(["lxmf"]);

    // Allow only webhook while also clearing deny -> only webhook remains.
    await SELF.fetch(`${BASE}/v1/devices/${key.deviceId}`, {
      method: "PATCH",
      headers: auth(a.token),
      body: JSON.stringify({ allow_transports: ["webhook"], deny_transports: null }),
    });
    const r2 = await devReq("/@devpol/alerts", "after-allow", { "x-dry-run": "1" });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { plan: { transport: string }[] }).plan.map((d) => d.transport)).toEqual(["webhook"]);
  });

  it("enforces topic rate_per_min and burst limits and validates quiet_hours timezone", async () => {
    const a = await bootstrap("ratelim", 5);
    const badTz = await SELF.fetch(`${BASE}/v1/topics/@ratelim/fast`, {
      method: "PUT", headers: auth(a.token),
      body: JSON.stringify({ policy: { quiet_hours: { start: "22:00", end: "07:00", tz: "Not/A_Zone" } } }),
    });
    expect(badTz.status).toBe(400);

    const put = await SELF.fetch(`${BASE}/v1/topics/@ratelim/fast`, {
      method: "PUT", headers: auth(a.token),
      body: JSON.stringify({ policy: { rate_per_min: 1, burst: 2, quiet_hours: { start: "22:00", end: "07:00", tz: "America/Chicago" } } }),
    });
    expect(put.status).toBe(201);

    // Burst of 2 succeeds; 3rd publish immediately gets 429 rate_limited.
    expect((await publish("@ratelim/fast", "1", auth(a.token))).status).toBe(200);
    expect((await publish("@ratelim/fast", "2", auth(a.token))).status).toBe(200);
    const r3 = await publish("@ratelim/fast", "3", auth(a.token));
    expect(r3.status).toBe(429);
    expect(await r3.json()).toMatchObject({ error: "rate_limited" });

    // Dry runs are still allowed while rate-limited.
    expect((await publish("@ratelim/fast", "dry", auth(a.token, { "X-Dry-Run": "1" }))).status).toBe(200);
  });

  it("updates and pauses subscriptions via PATCH /v1/subscriptions/:id and deletes topics via DELETE /v1/topics/:topic", async () => {
    const a = await bootstrap("subdel", 5);
    const b = await bootstrap("subdel2", 5);
    await publish("@subdel/alerts", "init", auth(a.token));

    const ep = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/subdel" }),
    })).json()) as { id: string };
    const sub = (await (await SELF.fetch(`${BASE}/v1/subscriptions`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ topic: "@subdel/alerts", endpoint_id: ep.id, after_s: 0 }),
    })).json()) as { id: string; paused: boolean };
    expect(sub.paused).toBe(false);

    // Pause subscription -> excluded from delivery plan & topic subscriber count.
    const paused = await SELF.fetch(`${BASE}/v1/subscriptions/${sub.id}`, {
      method: "PATCH", headers: auth(a.token),
      body: JSON.stringify({ paused: true }),
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ id: sub.id, paused: true });
    const dryPaused = (await (await publish("@subdel/alerts", "hi", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: unknown[] };
    expect(dryPaused.plan).toHaveLength(0);

    // Resume with min_priority: 4, after_s: 30, and tag filter.
    const resumed = await SELF.fetch(`${BASE}/v1/subscriptions/${sub.id}`, {
      method: "PATCH", headers: auth(a.token),
      body: JSON.stringify({ paused: false, min_priority: 4, after_s: 30, filter: { tags: ["urgent"] } }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ paused: false, min_priority: 4, after_s: 30, filter: { tags: ["urgent"] } });

    const dryLow = (await (await publish("@subdel/alerts", "low", auth(a.token, { "X-Dry-Run": "1", "X-Tags": "urgent" }))).json()) as { plan: unknown[] };
    expect(dryLow.plan).toHaveLength(0);
    const dryHigh = (await (await publish("@subdel/alerts", "high", auth(a.token, { "X-Dry-Run": "1", "X-Priority": "4", "X-Tags": "urgent" }))).json()) as { plan: { transport: string; after_s: number }[] };
    expect(dryHigh.plan).toEqual([expect.objectContaining({ transport: "webhook", after_s: 30 })]);

    // Another account cannot delete the topic.
    expect((await SELF.fetch(`${BASE}/v1/topics/@subdel/alerts`, { method: "DELETE", headers: auth(b.token) })).status).toBe(404);

    // Owner deletes the topic -> gone from topics, subscriptions, and DO.
    const del = await SELF.fetch(`${BASE}/v1/topics/@subdel/alerts`, { method: "DELETE", headers: auth(a.token) });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect((await SELF.fetch(`${BASE}/v1/topics/@subdel/alerts`, { headers: auth(a.token) })).status).toBe(404);
    const subsAfter = (await (await SELF.fetch(`${BASE}/v1/subscriptions`, { headers: auth(a.token) })).json()) as { subscriptions: unknown[] };
    expect(subsAfter.subscriptions).toHaveLength(0);
  });

  it("enforces token deny_transports, live/poll transport policies, and strict topic policy validation", async () => {
    const a = await bootstrap("tokdeny", 5);
    await publish("@tokdeny/alerts", "init", auth(a.token));
    const hook = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/tokdeny" }),
    })).json()) as { id: string };
    await SELF.fetch(`${BASE}/v1/subscriptions`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ topic: "@tokdeny/alerts", endpoint_id: hook.id }),
    });

    // Token denying webhook and poll.
    const tokRes = await SELF.fetch(`${BASE}/v1/tokens`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ name: "no-hook", scopes: ["publish:@tokdeny/*", "subscribe:@tokdeny/*"], deny_transports: ["webhook", "poll"] }),
    });
    expect(tokRes.status).toBe(201);
    const tok = (await tokRes.json()) as { id: string; token: string };
    const list = (await (await SELF.fetch(`${BASE}/v1/tokens`, { headers: auth(a.token) })).json()) as { tokens: { id: string; deny_transports: string[] | null }[] };
    expect(list.tokens.find((t) => t.id === tok.id)?.deny_transports).toEqual(["webhook", "poll"]);

    // Dry-run with the token excludes webhook; poll with the token is forbidden.
    const dry = (await (await publish("@tokdeny/alerts", "hi", auth(tok.token, { "X-Dry-Run": "1" }))).json()) as { plan: unknown[] };
    expect(dry.plan).toEqual([]);
    const polled = await SELF.fetch(`${BASE}/@tokdeny/alerts/json?poll=1`, { headers: { authorization: `Bearer ${tok.token}` } });
    expect(polled.status).toBe(403);

    // Invalid topic policy fields (unknown transport, out-of-range min_priority) are rejected.
    const badTransport = await SELF.fetch(`${BASE}/v1/topics/@tokdeny/alerts`, {
      method: "PUT", headers: auth(a.token),
      body: JSON.stringify({ policy: { deny_transports: ["carrier_pigeon"] } }),
    });
    expect(badTransport.status).toBe(400);
    const badMinPrio = await SELF.fetch(`${BASE}/v1/topics/@tokdeny/alerts`, {
      method: "PUT", headers: auth(a.token),
      body: JSON.stringify({ policy: { min_priority: { sms: 9 } } }),
    });
    expect(badMinPrio.status).toBe(400);
  });
});
