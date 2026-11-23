import { describe, expect, it } from "vitest";
import { actionPriceMicros, rentNanos, topupSplit } from "@subetha/pricing";
import { calculate, DEFAULT_RETENTION_S, PRICES, RELAY_TRANSPORTS, simulate, topupFor, usd } from "../src/tools.ts";

describe("pricing calculator", () => {
  it("prices a month the way the relay charges each message", () => {
    const r = calculate({ topupsUsd: 0, messagesPerMonth: 1000, deliveries: { ws: 2, webpush: 1 } });
    const publish = actionPriceMicros(PRICES, "publish");
    const retention = Math.ceil(rentNanos(PRICES, "retention_message_day", DEFAULT_RETENTION_S / 86400) / 1000);
    const ws = actionPriceMicros(PRICES, "deliver_live");
    const push = actionPriceMicros(PRICES, "deliver_push");
    expect(r.tier).toBe("standard");
    expect(r.perMessageMicros).toBe(publish + retention + 2 * ws + push);
    expect(r.totalMicros).toBe(1000 * (publish + retention + 2 * ws + push));
    expect(r.lines.map((l) => l.sku)).toEqual(["publish", "retention_message_day", "deliver_live", "deliver_push"]);
  });

  it("uses the tier for the top-up history", () => {
    expect(calculate({ topupsUsd: 600, messagesPerMonth: 1, deliveries: {} }).tier).toBe("bulk");
    expect(calculate({ topupsUsd: 5000, messagesPerMonth: 1, deliveries: {} }).tier).toBe("volume");
    const std = calculate({ topupsUsd: 0, messagesPerMonth: 100, deliveries: { sms: 1 } });
    const vol = calculate({ topupsUsd: 5000, messagesPerMonth: 100, deliveries: { sms: 1 } });
    expect(vol.totalMicros).toBeLessThan(std.totalMicros);
  });

  it("bills SMS per segment of the typical message", () => {
    const short = calculate({ topupsUsd: 0, messagesPerMonth: 10, deliveries: { sms: 1 }, sample: { message: "hi" } });
    const long = calculate({ topupsUsd: 0, messagesPerMonth: 10, deliveries: { sms: 1 }, sample: { message: "x".repeat(300) } });
    expect(short.smsSegments).toBe(1);
    expect(long.smsSegments).toBe(2);
    const line = (r: typeof short) => r.lines.find((l) => l.sku === "deliver_sms_us")!.micros;
    expect(line(long)).toBe(2 * line(short));
  });

  it("charges fractional escalations proportionally and rent per day", () => {
    const r = calculate({ topupsUsd: 0, messagesPerMonth: 100, deliveries: { sms: 0.1 }, devices: 2, endpoints: 1, connections: 1 });
    const sms = r.lines.find((l) => l.sku === "deliver_sms_us")!;
    expect(sms.quantity).toBeCloseTo(10);
    expect(sms.micros).toBe(10 * actionPriceMicros(PRICES, "deliver_sms_us"));
    const rent = r.lines.filter((l) => l.sku === "device_day" || l.sku === "endpoint_day").reduce((n, l) => n + l.micros, 0);
    expect(rent).toBe(30 * Math.ceil((rentNanos(PRICES, "device_day", 2) + rentNanos(PRICES, "endpoint_day", 1)) / 1000));
    expect(r.lines.find((l) => l.sku === "connection_hour")!.quantity).toBe(720);
  });

  it("ignores edge transports and clamps retention", () => {
    expect(RELAY_TRANSPORTS).not.toContain("ble");
    expect(RELAY_TRANSPORTS).toContain("sms");
    const a = calculate({ topupsUsd: 0, messagesPerMonth: 1, deliveries: {}, retentionS: 365 * 86400 });
    const b = calculate({ topupsUsd: 0, messagesPerMonth: 1, deliveries: {}, retentionS: 30 * 86400 });
    expect(a.totalMicros).toBe(b.totalMicros);
  });

  it("finds the smallest top-up that covers the month after fees", () => {
    for (const credit of [0, 1, 999_999, 4_000_000, 4_427_000, 12_345_678, 250_000_000]) {
      const { amountMicros } = topupFor(credit);
      expect(amountMicros % 10_000).toBe(0);
      expect(amountMicros).toBeGreaterThanOrEqual(PRICES.topup.min_usd_micros);
      expect(topupSplit(PRICES, amountMicros).creditMicros).toBeGreaterThanOrEqual(credit);
      const less = amountMicros - 10_000;
      if (less >= PRICES.topup.min_usd_micros) expect(topupSplit(PRICES, less).creditMicros).toBeLessThan(credit);
    }
    expect(topupFor(10_000_000_000).overMax).toBe(true);
  });
});

describe("route simulator", () => {
  const base = { mode: "any" as const, priority: 3, message: "Opened", live: 1, subscriptions: [], nowMs: Date.UTC(2026, 0, 1, 12) };

  it("delivers live first and escalates in order", () => {
    const r = simulate({ ...base, priority: 5, subscriptions: [{ transport: "voice", after_s: 180 }, { transport: "webpush" }, { transport: "sms", after_s: 60 }] });
    expect(r.steps.map((s) => s.transport)).toEqual(["ws", "webpush", "sms", "voice"]);
    const total = r.steps.reduce((n, s) => n + s.cost_micros, 0);
    expect(r.worstCaseMicros).toBe(r.publishMicros + r.retentionMicros + total);
    const immediate = r.steps.filter((s) => s.after_s === 0).reduce((n, s) => n + s.cost_micros, 0);
    expect(r.ackedMicros).toBe(r.publishMicros + r.retentionMicros + immediate);
  });

  it("applies route modes, priorities, policies, and caps", () => {
    const subs = [{ transport: "webpush" as const }, { transport: "sms" as const, after_s: 60, min_priority: 4 }];
    expect(simulate({ ...base, subscriptions: subs }).plan.dropped).toEqual([{ subscriber: "sub_2_sms", transport: "sms", reason: "below minimum priority" }]);
    expect(simulate({ ...base, mode: "cheap", subscriptions: subs }).steps.map((s) => s.transport)).toEqual(["ws"]);
    expect(simulate({ ...base, priority: 5, deny: ["sms"], subscriptions: subs }).plan.dropped[0]!.reason).toBe("transport denied by policy");
    expect(simulate({ ...base, priority: 5, tokenTransports: ["ws", "webpush"], subscriptions: subs }).plan.dropped[0]!.reason).toBe("transport denied by policy");
    const quiet = simulate({ ...base, policy: { quiet_hours: { start: "11:00", end: "13:00" } }, subscriptions: subs });
    expect(quiet.plan.dropped.every((d) => d.reason === "quiet hours")).toBe(true);
    const capped = simulate({ ...base, priority: 5, maxCostUsd: 0.001, subscriptions: subs });
    expect(capped.plan.dropped.map((d) => d.reason)).toEqual(["max cost"]);
    const all = simulate({ ...base, mode: "all", priority: 5, subscriptions: subs });
    expect(all.steps.every((s) => s.after_s === 0)).toBe(true);
    expect(all.ackedMicros).toBe(all.worstCaseMicros);
  });

  it("bills an SMS subscriber one MMS when the message has a picture", () => {
    const subs = [{ transport: "sms" as const }];
    const text = simulate({ ...base, message: "x".repeat(300), subscriptions: subs });
    const pic = simulate({ ...base, message: "x".repeat(300), subscriptions: subs, image: true });
    expect(text.steps.find((s) => s.transport === "sms")).toMatchObject({ sku: "deliver_sms_us", cost_micros: actionPriceMicros(PRICES, "deliver_sms_us", "standard", 2) });
    expect(pic.steps.find((s) => s.transport === "sms")).toMatchObject({ sku: "deliver_mms_us", cost_micros: actionPriceMicros(PRICES, "deliver_mms_us", "standard") });
  });

  it("counts SMS segments of the rendered message", () => {
    const r = simulate({ ...base, priority: 5, title: "T", message: "y".repeat(200), subscriptions: [{ transport: "sms" }] });
    expect(r.smsSegments).toBe(2);
    expect(r.steps.find((s) => s.transport === "sms")!.cost_micros).toBe(actionPriceMicros(PRICES, "deliver_sms_us", "standard", 2));
  });
});

describe("usd", () => {
  it("formats small and large amounts", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(6)).toBe("$0.000006");
    expect(usd(15_000)).toBe("$0.015");
    expect(usd(12_345_678)).toBe("$12.35");
  });
});
