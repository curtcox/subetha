import { describe, expect, it } from "vitest";
import { parseActions, parseHeaderPublish, parseJsonPublish, parseTopicPath } from "../src/ntfy.ts";
import { planDeliveries, inQuietHours } from "../src/routing.ts";
import prices from "@subetha/pricing/prices.json";
import type { PriceTable } from "@subetha/pricing";

describe("parseTopicPath", () => {
  it("handles namespaced, secret, multi-topic and format suffixes", () => {
    expect(parseTopicPath("/@alice/door")).toEqual({ topics: ["@alice/door"], format: null });
    expect(parseTopicPath("/@alice/door/json")).toEqual({ topics: ["@alice/door"], format: "json" });
    expect(parseTopicPath("/@alice/ws")).toEqual({ topics: ["@alice/ws"], format: null });
    expect(parseTopicPath("/@alice/ws/ws")).toEqual({ topics: ["@alice/ws"], format: "ws" });
    expect(parseTopicPath("/@a/x,@a/y/sse")).toEqual({ topics: ["@a/x", "@a/y"], format: "sse" });
    expect(parseTopicPath("/t_abcdefghijklmnopqrstuvwxyz/raw")).toEqual({ topics: ["t_abcdefghijklmnopqrstuvwxyz"], format: "raw" });
    expect(parseTopicPath("/v1/health")).toBeNull();
    expect(parseTopicPath("/")).toBeNull();
    expect(() => parseTopicPath("/@Alice/x")).toThrow();
  });
});

describe("parseActions", () => {
  it("parses the ntfy short format and JSON", () => {
    expect(parseActions("view, Open, https://a.b; http, Close, https://c.d, clear=true")).toEqual([
      { action: "view", label: "Open", url: "https://a.b" },
      { action: "http", label: "Close", url: "https://c.d", clear: true },
    ]);
    expect(parseActions('[{"action":"view","label":"x","url":"y"}]')).toHaveLength(1);
  });
});

describe("parseJsonPublish", () => {
  it("normalizes PLAN §4 route.max_cost_usd to integer max_cost_usd_micros", async () => {
    const req = new Request("https://subetha.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "@alice/doorbell",
        message: "Opened",
        route: { mode: "any", max_cost_usd: 0.02, deny: ["sms"], deadline_s: 60 },
      }),
    });
    const parsed = await parseJsonPublish(req);
    expect(parsed.route.maxCost).toBe(20_000);
    expect(parsed.route.deadlineS).toBe(60);
    expect(parsed.envelope.route?.max_cost_usd_micros).toBe(20_000);
    expect((parsed.envelope.route as Record<string, unknown>)?.max_cost_usd).toBeUndefined();
  });

  it("rejects negative route.max_cost_usd", async () => {
    const req = new Request("https://subetha.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "@alice/doorbell", message: "x", route: { max_cost_usd: -1 } }),
    });
    await expect(parseJsonPublish(req)).rejects.toThrow(/max_cost_usd/);
  });

  it("supports X-Dry-Run: yes and ?dry-run=1 consistently", async () => {
    const req = new Request("https://subetha.test/?dry-run=yes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "@alice/doorbell", message: "x" }),
    });
    const parsed = await parseJsonPublish(req);
    expect(parsed.dryRun).toBe(true);
  });
});

describe("parseHeaderPublish", () => {
  it("parses X-Content-Type, Content-Type, and X-Hops", async () => {
    const req = new Request("https://subetha.test/@alice/door", {
      method: "POST",
      headers: { "x-content-type": "application/json", "x-hops": "3" },
      body: '{"ok":true}',
    });
    const parsed = await parseHeaderPublish(req, "@alice/door");
    expect(parsed.envelope.content_type).toBe("application/json");
    expect(parsed.envelope.hops).toBe(3);

    const inferred = await parseHeaderPublish(
      new Request("https://subetha.test/@alice/door", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "AQID" }),
      "@alice/door",
    );
    expect(inferred.envelope.content_type).toBe("application/octet-stream");

    await expect(
      parseHeaderPublish(new Request("https://subetha.test/@alice/door", { method: "POST", headers: { "x-hops": "99" }, body: "hi" }), "@alice/door"),
    ).rejects.toThrow(/X-Hops/);
  });
});

describe("planDeliveries", () => {
  const base = { liveSubscribers: ["c1"], mode: "any" as const, priority: 3, allowLists: [], denyLists: [], policy: {}, maxCostMicros: null, prices: prices as unknown as PriceTable, tier: "standard", nowMs: Date.UTC(2026, 0, 1, 12) };
  const queued = [
    { id: "push", transport: "webpush" as const, endpoint: "e1" },
    { id: "sms", transport: "sms" as const, endpoint: "e2", after_s: 60, min_priority: 4 },
    { id: "voice", transport: "voice" as const, endpoint: "e3", after_s: 300 },
  ];
  it("applies min priority, deny lists, and escalation delays", () => {
    const p = planDeliveries({ ...base, queued, priority: 5, denyLists: [["voice"]] });
    expect(p.deliveries.map((d) => [d.subscriber, d.after_s])).toEqual([["c1", 0], ["push", 0], ["sms", 60]]);
    expect(p.dropped).toEqual([{ subscriber: "voice", transport: "voice", reason: "transport denied by policy" }]);
    const low = planDeliveries({ ...base, queued, priority: 3 });
    expect(low.dropped.find((d) => d.subscriber === "sms")?.reason).toBe("below minimum priority");
  });
  it("cheap mode drops paid transports; all mode sends immediately", () => {
    expect(planDeliveries({ ...base, queued, mode: "cheap" }).deliveries.map((d) => d.subscriber)).toEqual(["c1"]);
    expect(planDeliveries({ ...base, queued, mode: "all", priority: 5 }).deliveries.every((d) => d.after_s === 0)).toBe(true);
  });
  it("drops the latest, most expensive steps to fit max cost", () => {
    const p = planDeliveries({ ...base, queued, priority: 5, maxCostMicros: 20_000 });
    expect(p.deliveries.map((d) => d.subscriber)).toEqual(["c1", "push", "sms"]);
    expect(p.costMicros).toBeLessThanOrEqual(20_000);
  });
  it("quiet hours suppress paid transports, including across midnight", () => {
    expect(inQuietHours({ start: "22:00", end: "07:00" }, Date.UTC(2026, 0, 1, 23))).toBe(true);
    expect(inQuietHours({ start: "22:00", end: "07:00" }, Date.UTC(2026, 0, 1, 12))).toBe(false);
    const p = planDeliveries({ ...base, queued, priority: 5, policy: { quiet_hours: { start: "11:00", end: "13:00" } } });
    expect(p.deliveries.map((d) => d.subscriber)).toEqual(["c1"]);
  });
  it("drops escalation steps scheduled at or after deadlineS", () => {
    const p = planDeliveries({ ...base, queued, priority: 5, deadlineS: 120 });
    expect(p.deliveries.map((d) => [d.subscriber, d.after_s])).toEqual([["c1", 0], ["push", 0], ["sms", 60]]);
    expect(p.dropped).toEqual([{ subscriber: "voice", transport: "voice", reason: "past deadline" }]);
    const tight = planDeliveries({ ...base, queued, priority: 5, deadlineS: 60 });
    expect(tight.deliveries.map((d) => d.subscriber)).toEqual(["c1", "push"]);
    expect(tight.dropped.map((d) => [d.subscriber, d.reason])).toEqual([["sms", "past deadline"], ["voice", "past deadline"]]);
  });
  it("enforces transport policies and min_priority on live subscribers and prevents subscriptions from weakening topic min_priority", () => {
    const live = [{ id: "w1", transport: "ws" as const }, { id: "s1", transport: "sse" as const }];
    const denied = planDeliveries({ ...base, liveSubscribers: live, queued: [], denyLists: [["ws"]] });
    expect(denied.deliveries.map((d) => [d.subscriber, d.transport])).toEqual([["s1", "sse"]]);
    expect(denied.dropped).toEqual([{ subscriber: "w1", transport: "ws", reason: "transport denied by policy" }]);

    const subWeak = [{ id: "sms", transport: "sms" as const, endpoint: "e2", min_priority: 1 }];
    const strictTopic = planDeliveries({ ...base, liveSubscribers: [], queued: subWeak, priority: 3, policy: { min_priority: { sms: 4 } } });
    expect(strictTopic.deliveries).toEqual([]);
    expect(strictTopic.dropped).toEqual([{ subscriber: "sms", transport: "sms", reason: "below minimum priority" }]);
  });
  it("sorts any mode cheapest-first and fast mode fastest-first", () => {
    const mix = [
      { id: "email", transport: "email" as const, endpoint: "e1" },
      { id: "sms", transport: "sms" as const, endpoint: "e2" },
      { id: "hook", transport: "webhook" as const, endpoint: "e3" },
    ];
    const anyPlan = planDeliveries({ ...base, liveSubscribers: [], queued: mix, mode: "any" });
    expect(anyPlan.deliveries.map((d) => d.transport)).toEqual(["webhook", "email", "sms"]);
    const fastPlan = planDeliveries({ ...base, liveSubscribers: [], queued: mix, mode: "fast" });
    expect(fastPlan.deliveries.map((d) => d.transport)).toEqual(["webhook", "sms", "email"]);
  });
});
