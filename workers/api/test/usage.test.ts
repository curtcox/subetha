import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { aggregateUsage, categorize, leaseTopic, skuOf } from "../src/usage.ts";
import { auth, balance, BASE, bootstrap, publish } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 21, 15);
const DAY = 86_400_000;

describe("usage aggregation", () => {
  it("categorizes refs by prefix", () => {
    expect(categorize("pub:01JD")).toBe("publish");
    expect(categorize("dlv:01JD:sub_1:01JE")).toBe("deliveries");
    expect(categorize("lease:@me/door:01JD")).toBe("live");
    expect(categorize("rent:2026-11-21")).toBe("rent");
    expect(categorize("dry:01JD")).toBe("other");
    expect(categorize("topup:cs_123")).toBeNull();
    expect(leaseTopic("lease:@me/door:01JD")).toBe("@me/door");
  });

  it("counts closed refs on their first day, open ones as pending, and skips earlier refs", () => {
    const u = aggregateUsage([
      { ref: "pub:a", start: NOW - 1000, net: -6, closed: 1 },
      { ref: "dlv:a:s:1", start: NOW - DAY, net: -16_602, closed: 1, meta: "sku=deliver_sms_us" }, // reserved yesterday, settled today: counts yesterday
      { ref: "dlv:a:s:2", start: NOW, net: -74_000, closed: 0, meta: "sku=deliver_voice_us" }, // still in flight
      { ref: "lease:@me/door:1", start: NOW - 2 * DAY, net: -3, closed: 1 },
      { ref: "lease:@me/door:2", start: NOW - 2 * DAY, net: -4, closed: 1 },
      { ref: "lease:@me/bell:1", start: NOW, net: 0, closed: 1 }, // fully returned
      { ref: "rent:2026-10-01", start: NOW - 40 * DAY, net: -100, closed: 1 }, // before the window
      { ref: "topup:cs_1", start: NOW, net: 5_000_000, closed: 1 },
    ], NOW, 7);
    expect(u.days.map((d) => d.day)).toEqual(["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(u.days.at(-1)!.micros.publish).toBe(6);
    expect(u.days.at(-2)!.micros.deliveries).toBe(16_602);
    expect(u.days.at(-3)!.micros.live).toBe(7);
    expect(u.totals).toEqual({ publish: 6, deliveries: 16_602, live: 7, rent: 0, other: 0 });
    expect(u.total_micros).toBe(16_615);
    expect(u.pending_micros).toBe(74_000);
    expect(u.live_by_topic).toEqual([{ topic: "@me/door", micros: 7 }]);
    expect(u.by_sku).toEqual([
      { sku: "deliver_sms_us", micros: 16_602 },
      { sku: "deliver_live", micros: 7 },
      { sku: "publish", micros: 6 },
    ]);
    expect(skuOf("dlv:a:s:1", "sku=deliver_webhook")).toBe("deliver_webhook");
    expect(skuOf("inmail:abc")).toBe("inbound_email");
  });
});

describe("GET /v1/usage", () => {
  it("reports what the account actually spent", async () => {
    const a = await bootstrap("spender", 2);
    const before = await balance(a.token);
    for (let i = 0; i < 3; i++) expect((await publish("@spender/x", `m${i}`, auth(a.token))).status).toBe(200);
    expect((await publish("@spender/x", "dry", auth(a.token, { "X-Dry-Run": "1" }))).status).toBe(200);
    const r = await SELF.fetch(`${BASE}/v1/usage?days=7`, { headers: auth(a.token) });
    expect(r.status).toBe(200);
    const u = (await r.json()) as { days: { total: number }[]; totals: Record<string, number>; total_micros: number; pending_micros: number; categories: Record<string, string> };
    expect(u.days.length).toBe(7);
    expect(u.totals.publish).toBeGreaterThan(0);
    expect(u.totals.other).toBeGreaterThan(0);
    expect(u.categories.publish).toBe("Publishing");
    // Everything that left the balance is either counted or pending (leases topics still hold).
    expect(u.total_micros + u.pending_micros).toBe(before - (await balance(a.token)));
  });

  it("is admin-only and clamps days", async () => {
    const a = await bootstrap("spender2");
    const t = (await (await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ scopes: ["publish"] }) })).json()) as { token: string };
    expect((await SELF.fetch(`${BASE}/v1/usage`, { headers: auth(t.token) })).status).toBe(403);
    const u = (await (await SELF.fetch(`${BASE}/v1/usage?days=1000`, { headers: auth(a.token) })).json()) as { days: unknown[] };
    expect(u.days.length).toBe(90);
  });
});
