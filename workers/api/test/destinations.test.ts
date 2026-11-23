// Per-destination SMS/voice pricing outside the US (PLAN §8, rule 5, and per-country opt-in).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { livePriceMicros, type PriceTable } from "@subetha/pricing";
import PRICES from "@subetha/pricing/prices.json";
import { MAX_PROVIDER_USD, repriceDestinations } from "../src/cron.ts";
import { DEST_PRICES_KEY, phoneCountry, parseCountries, type DestinationPrices } from "../src/delivery/destinations.ts";
import { planDeliveries } from "../src/routing.ts";
import type { Env } from "../src/types.ts";
import { auth, balance, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;
const P = PRICES as unknown as PriceTable;
const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, body: string) => Response) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    const body = input instanceof Request ? await input.text() : String(init.body ?? "");
    calls.push({ url, body });
    return handler(url, body);
  });
  return calls;
}

/** Twilio Pricing API stand-in: `sms`/`voice` map ISO → prices; anything else is a 404. */
const twilioPricing = (sms: Record<string, string[]>, voice: Record<string, string[]>) => (url: string) => {
  const m = /\/v2\/(Messaging|Voice)\/Countries\/([A-Z]{2})$/.exec(url);
  if (!m) return new Response(JSON.stringify({ sid: "SM1", num_segments: "1" }), { status: 201 });
  const list = (m[1] === "Messaging" ? sms : voice)[m[2]!];
  if (!list) return new Response("not found", { status: 404 });
  return m[1] === "Messaging"
    ? Response.json({ outbound_sms_prices: [{ carrier: "x", prices: list.map((p) => ({ number_type: "mobile", current_price: p })) }] })
    : Response.json({ outbound_prefix_prices: list.map((p) => ({ prefixes: ["44"], current_price: p })) });
};

describe("phone destinations", () => {
  it("maps E.164 numbers to countries and keeps non-US NANP codes out of US pricing", () => {
    expect(phoneCountry("+14155550123")).toBe("US");
    expect(phoneCountry("+14165550123")).toBe("CA"); // Toronto
    expect(phoneCountry("+17875550123")).toBe("PR");
    expect(phoneCountry("+18765550123")).toBeNull(); // Jamaica: not served
    expect(phoneCountry("+19005550123")).toBeNull(); // premium rate
    expect(phoneCountry("+15005550123")).toBeNull(); // non-geographic
    expect(phoneCountry("+14115550123")).toBeNull(); // N11 isn't an area code
    expect(phoneCountry("+447700900123")).toBe("GB");
    expect(phoneCountry("+353861234567")).toBe("IE"); // longest calling code wins over +35…
    expect(phoneCountry("+3581234567")).toBe("FI");
    expect(phoneCountry("+2348012345678")).toBeNull(); // Nigeria: not in the list
    expect(phoneCountry("447700900123")).toBeNull();
    expect(phoneCountry("+44")).toBeNull();
  });
  it("normalizes opt-in lists", () => {
    expect(parseCountries(["gb", "CA", "GB"])).toEqual(["CA", "GB"]);
    expect(parseCountries(["US"])).toBeNull(); // the US is always on
    expect(parseCountries(["XX"])).toBeNull();
    expect(parseCountries("GB")).toBeNull();
  });
});

describe("daily repricing", () => {
  it("prices each country from Twilio's highest current price and leaves out unknown or extreme ones", async () => {
    await E.CACHE.delete(DEST_PRICES_KEY);
    stub(twilioPricing({ GB: ["0.0400", "0.0524"], CA: ["0.0083"], DE: [String(MAX_PROVIDER_USD + 0.01)] }, { GB: ["0.0140", "0.1800"] }));
    await repriceDestinations(E, 1_700_000_000_000);
    const t = (await E.CACHE.get<DestinationPrices>(DEST_PRICES_KEY, "json"))!;
    expect(t.updated_at).toBe(1_700_000_000_000);
    expect(t.countries.GB!.sms!.standard).toBe(livePriceMicros(P, "deliver_sms_intl", "twilio", 0.0524, "standard"));
    expect(t.countries.GB!.sms!.volume).toBeLessThan(t.countries.GB!.sms!.standard!);
    expect(t.countries.GB!.voice!.standard).toBe(livePriceMicros(P, "deliver_voice_intl", "twilio", 0.18, "standard"));
    expect(t.countries.CA!.sms).toBeDefined();
    expect(t.countries.CA!.voice).toBeUndefined();
    expect(t.countries.DE).toBeUndefined(); // above the toll-fraud ceiling
    expect(t.countries.FR).toBeUndefined(); // Twilio had no price

    // Twilio unreachable: yesterday's table stays until it expires.
    stub(() => new Response("down", { status: 503 }));
    await repriceDestinations(E, 1_700_086_400_000);
    expect((await E.CACHE.get<DestinationPrices>(DEST_PRICES_KEY, "json"))!.updated_at).toBe(1_700_000_000_000);

    const pub = (await (await SELF.fetch(`${BASE}/v1/prices/destinations`)).json()) as { countries: Record<string, { sms_usd_micros: Record<string, number> | null }> };
    expect(pub.countries.GB!.sms_usd_micros!.standard).toBe(t.countries.GB!.sms!.standard);
    expect(pub.countries.FR!.sms_usd_micros).toBeNull();
  });
});

describe("international endpoints", () => {
  it("requires the country opt-in and a current price, charges the destination price, and plans with it", async () => {
    const a = await bootstrap("globetrotter", 10);
    const gb = "+447700900456";
    const create = (address: string) => SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "sms", address }) });
    const patch = (body: unknown) => SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify(body) });
    await E.CACHE.delete(DEST_PRICES_KEY);
    const calls = stub(twilioPricing({ GB: ["0.0524"] }, {}));

    expect((await create(gb)).status).toBe(403); // not opted in
    expect((await patch({ telephony_countries: ["XX"] })).status).toBe(400);
    expect((await patch({ telephony_countries: ["gb"] })).status).toBe(200);
    const acct = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { telephony_countries: string[] };
    expect(acct.telephony_countries).toEqual(["GB"]);
    expect((await create(gb)).status).toBe(503); // no price yet: unknown destinations are rejected

    await repriceDestinations(E, Date.now());
    const unit = livePriceMicros(P, "deliver_sms_intl", "twilio", 0.0524, "standard")!;
    const before = await balance(a.token);
    const r = await create(gb);
    expect(r.status).toBe(201);
    expect(before - (await balance(a.token))).toBe(unit); // the code was paid at the GB price
    expect(calls.at(-1)!.body).toContain("To=%2B447700900456");
    const ep = (await r.json()) as { id: string };
    await E.DB.prepare("UPDATE endpoints SET verified_at = ? WHERE id = ?").bind(Date.now(), ep.id).run();

    await publish("@globetrotter/news", "init", auth(a.token));
    expect((await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@globetrotter/news", endpoint_id: ep.id }) })).status).toBe(201);
    const dry = (await (await publish("@globetrotter/news", "hello", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: { transport: string; sku: string; cost_micros: number }[] };
    expect(dry.plan).toEqual([expect.objectContaining({ transport: "sms", sku: "deliver_sms_intl", cost_micros: unit })]);

    // Turning the country off takes its numbers out of every plan.
    expect((await patch({ telephony_countries: [] })).status).toBe(200);
    const off = (await (await publish("@globetrotter/news", "hello", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: unknown[] };
    expect(off.plan).toEqual([]);
  });

  it("drops non-US numbers from a plan when the country has no current price", () => {
    const p = planDeliveries({
      liveSubscribers: [], mode: "any", priority: 3, allowLists: [], denyLists: [], policy: {}, maxCostMicros: null, prices: P, tier: "standard", nowMs: 0,
      queued: [{ id: "s1", transport: "sms", endpoint: "e1", country: "GB" }, { id: "s2", transport: "sms", endpoint: "e2", country: "CA" }, { id: "s3", transport: "sms", endpoint: "e3" }],
      units: { sms: 2 },
      destPrice: (_t, c) => (c === "GB" ? 70_000 : null),
    });
    expect(p.deliveries.map((d) => [d.subscriber, d.sku, d.cost_micros])).toEqual([["s1", "deliver_sms_intl", 140_000], ["s3", "deliver_sms_us", 2 * P.skus.deliver_sms_us!.price_nanos.standard! / 1000]]);
    expect(p.dropped).toEqual([{ subscriber: "s2", transport: "sms", reason: "destination price unknown" }]);
  });
});
