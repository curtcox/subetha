import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
});
