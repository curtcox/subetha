import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  actionPriceMicros, generatePrices, PricingInvariantError, rentNanos, skuForTransport, tierFor, topupSplit,
  type CostsFile, type PriceTable,
} from "../src/index.ts";

const costs = parse(readFileSync(new URL("../costs.yaml", import.meta.url), "utf8")) as CostsFile;
const committed = JSON.parse(readFileSync(new URL("../generated/prices.json", import.meta.url), "utf8")) as PriceTable;
const clone = (): CostsFile => structuredClone(costs);

describe("generated price table", () => {
  it("is in sync with costs.yaml", () => expect(generatePrices(costs)).toEqual(committed));

  it("every SKU at every tier has price > cost and margin ≥ min_margin", () => {
    for (const [id, s] of Object.entries(committed.skus)) for (const t of committed.tiers) {
      const p = s.price_nanos[t.id]!;
      expect(p, id).toBeGreaterThan(s.cost_nanos);
      expect((p - s.cost_nanos) / p, `${id}@${t.id}`).toBeGreaterThanOrEqual(committed.min_margin);
    }
  });

  it("action SKUs are whole micro-dollars", () => {
    for (const s of Object.values(committed.skus)) if (s.charge === "action") for (const p of Object.values(s.price_nanos)) expect(p % 1000).toBe(0);
  });

  it("every relay transport has a SKU; edge transports have none", () => {
    for (const t of ["ws", "sse", "poll", "webpush", "apns", "fcm", "webhook", "email", "slack", "sms", "voice", "mcp", "lxmf"]) expect(skuForTransport(committed, t), t).not.toBeNull();
    for (const t of ["ble", "audio", "qr", "lan"]) expect(skuForTransport(committed, t)).toBeNull();
  });
});

describe("invariants reject bad configs", () => {
  it("rejects a SKU whose markup is too thin", () => {
    const c = clone();
    c.skus.deliver_sms_us!.markup = 0.05;
    c.skus.deliver_sms_us!.floor_usd = 0.00001;
    expect(() => generatePrices(c)).toThrow(PricingInvariantError);
  });
  it("rejects a top-up fee below Stripe's worst case", () => {
    const c = clone();
    c.topup.fee_percent = 2.9;
    expect(() => generatePrices(c)).toThrow(/topup/);
  });
  it("rejects zero floors and duplicate transport mappings", () => {
    const c = clone();
    c.skus.publish!.floor_usd = 0;
    c.skus.deliver_slack!.transports = ["slack", "webhook"];
    try {
      generatePrices(c);
      expect.unreachable();
    } catch (e) {
      const v = (e as PricingInvariantError).violations.join("\n");
      expect(v).toMatch(/floor_usd/);
      expect(v).toMatch(/transport webhook/);
    }
  });
  it("property: any positive costs with markup ≥ 0.2 and floor > 0 yield a valid table", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 200; i++) {
      const c = clone();
      for (const s of Object.values(c.skus)) {
        for (const k of Object.keys(s.components)) s.components[k] = rnd() * 10 ** -(2 + Math.floor(rnd() * 6));
        s.markup = 0.36 + rnd() * 2; // × min tier factor 0.5 → ≥ 0.18 → margin ≥ 15.3%
        s.floor_usd = 1e-8 + rnd() * 1e-5;
      }
      const t = generatePrices(c);
      for (const s of Object.values(t.skus)) for (const m of Object.values(s.margin)) expect(m).toBeGreaterThanOrEqual(0.15);
    }
  });
});

describe("runtime helpers", () => {
  it("prices actions in µ$", () => {
    expect(actionPriceMicros(committed, "publish")).toBe(6);
    expect(actionPriceMicros(committed, "deliver_sms_us", "standard", 3)).toBe(3 * committed.skus.deliver_sms_us!.price_nanos.standard! / 1000);
    expect(() => actionPriceMicros(committed, "nope")).toThrow();
  });
  it("accrues rent in nanos", () => expect(rentNanos(committed, "retention_message_day", 10)).toBe(1000));
  it("splits top-ups", () => {
    const { feeMicros, creditMicros } = topupSplit(committed, 20_000_000);
    expect(feeMicros).toBe(900_000 + 350_000);
    expect(creditMicros).toBe(20_000_000 - 1_250_000);
    expect(() => topupSplit(committed, 1_000_000)).toThrow();
  });
  it("picks tiers", () => {
    expect(tierFor(committed, 0)).toBe("standard");
    expect(tierFor(committed, 600_000_000)).toBe("bulk");
    expect(tierFor(committed, 6_000_000_000)).toBe("volume");
  });
});
