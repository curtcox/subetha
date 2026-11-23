// MMS: a message with an image attachment goes to US SMS subscribers as one MMS (PLAN §6).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionPriceMicros, type PriceTable } from "@subetha/pricing";
import PRICES from "@subetha/pricing/prices.json";
import { processJob } from "../src/delivery/consumer.ts";
import { MMS_MAX_BYTES, MMS_SKU, mmsMedia } from "../src/delivery/units.ts";
import { planDeliveries, type PlanInput } from "../src/routing.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;
const P = PRICES as unknown as PriceTable;
const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

function stubTwilio() {
  const calls: { url: string; body: URLSearchParams }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    return new Response(JSON.stringify({ sid: `SM${calls.length}`, num_segments: "1" }), { status: 201 });
  });
  return calls;
}

const jpeg = { name: "snap.jpg", url: "https://subetha.us/file/abc/snap.jpg", type: "image/jpeg", size: 81234 };

describe("mmsMedia", () => {
  it("takes unencrypted JPEG/PNG/GIF attachments of known size up to 5 MB", () => {
    expect(mmsMedia({ attachment: jpeg })).toBe(jpeg.url);
    expect(mmsMedia({ attachment: { ...jpeg, type: "image/png" } })).toBe(jpeg.url);
    expect(mmsMedia({ attachment: { ...jpeg, size: MMS_MAX_BYTES } })).toBe(jpeg.url);
  });
  it("leaves everything else as plain SMS", () => {
    expect(mmsMedia({})).toBeNull();
    expect(mmsMedia({ attachment: { ...jpeg, size: MMS_MAX_BYTES + 1 } })).toBeNull();
    expect(mmsMedia({ attachment: { ...jpeg, size: undefined } })).toBeNull();
    expect(mmsMedia({ attachment: { ...jpeg, type: "application/pdf" } })).toBeNull();
    expect(mmsMedia({ attachment: { ...jpeg, type: undefined } })).toBeNull();
    expect(mmsMedia({ attachment: { ...jpeg, url: "javascript:alert(1)" } })).toBeNull();
    expect(mmsMedia({ attachment: jpeg, enc: { alg: "xchacha20poly1305", kid: "k", nonce: "AA" } })).toBeNull();
  });
});

describe("planning", () => {
  const base: PlanInput = {
    liveSubscribers: [],
    queued: [{ id: "us", transport: "sms", endpoint: "e1" }, { id: "gb", transport: "sms", endpoint: "e2", country: "GB" }, { id: "call", transport: "voice", endpoint: "e3" }],
    mode: "all", priority: 3, allowLists: [], denyLists: [], policy: {}, maxCostMicros: null, prices: P, tier: "standard", nowMs: 0,
    units: { sms: 2, voice: 3 },
    destPrice: () => 40_000,
  };

  it("bills US SMS subscribers one MMS instead of segments; other countries and voice are unchanged", () => {
    const plain = planDeliveries(base).deliveries;
    const mms = planDeliveries({ ...base, mms: true }).deliveries;
    const by = (ds: typeof mms, id: string) => ds.find((d) => d.subscriber === id)!;
    expect(by(plain, "us")).toMatchObject({ sku: "deliver_sms_us", cost_micros: actionPriceMicros(P, "deliver_sms_us", "standard", 2) });
    expect(by(mms, "us")).toMatchObject({ sku: MMS_SKU, cost_micros: actionPriceMicros(P, MMS_SKU, "standard") });
    expect(by(mms, "gb")).toEqual(by(plain, "gb"));
    expect(by(mms, "call")).toEqual(by(plain, "call"));
  });

  it("prices an MMS above a one-segment SMS", () => {
    expect(actionPriceMicros(P, MMS_SKU, "standard")).toBeGreaterThan(actionPriceMicros(P, "deliver_sms_us", "standard"));
  });
});

describe("end to end", () => {
  async function smsSubscriber(handle: string, phone: string) {
    const a = await bootstrap(handle, 5);
    await publish(`@${handle}/cam`, "init", auth(a.token));
    const calls = stubTwilio();
    const ep = (await (await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "sms", address: phone }) })).json()) as { id: string };
    const code = /code is (\d{6})/.exec(calls[0]!.body.get("Body")!)![1];
    expect((await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}/verify`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ code }) })).status).toBe(200);
    const sub = (await (await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: `@${handle}/cam`, endpoint_id: ep.id }) })).json()) as { id: string };
    calls.length = 0;
    return { a, ep, sub, calls };
  }

  it("plans an MMS for an image upload and sends it with MediaUrl", async () => {
    const { a, ep, sub, calls } = await smsSubscriber("mmscam", "+14155550142");
    const put = (dry: boolean) => SELF.fetch(`${BASE}/@mmscam/cam`, { method: "PUT", body: new Uint8Array(2048), headers: auth(a.token, { "X-Filename": "snap.jpg", "content-type": "image/jpeg", "X-Title": "Porch", ...(dry ? { "X-Dry-Run": "1" } : {}) }) });

    const dry = (await (await put(true)).json()) as { plan: { sku: string; cost_micros: number }[] };
    expect(dry.plan).toEqual([expect.objectContaining({ sku: MMS_SKU, cost_micros: actionPriceMicros(P, MMS_SKU, "standard") })]);

    const msg = (await (await put(false)).json()) as { id: string; attachment: { url: string } };
    const job: DeliveryJob = {
      topic: "@mmscam/cam", owner: a.account_id, message: { topic: "@mmscam/cam", id: msg.id, title: "Porch", message: "You received a file: snap.jpg", attachment: { ...jpeg, url: msg.attachment.url, size: 2048 } },
      sub: { id: sub.id, transport: "sms", endpoint: ep.id }, reservation: { ref: `dlv:${msg.id}:${sub.id}:mms`, micros: actionPriceMicros(P, MMS_SKU, "standard") }, attempt: 0, sku: MMS_SKU,
    };
    expect(await processJob(job, E)).toBe("delivered");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.get("MediaUrl")).toBe(msg.attachment.url);
    expect(calls[0]!.body.get("To")).toBe("+14155550142");
    expect(calls[0]!.body.get("Body")).toMatch(/^Porch: /);
  });

  it("sends a plain SMS for jobs planned as SMS (including jobs queued before MMS existed)", async () => {
    const { a, ep, sub, calls } = await smsSubscriber("mmsold", "+14155550143");
    const job: DeliveryJob = {
      topic: "@mmsold/cam", owner: a.account_id, message: { topic: "@mmsold/cam", id: "01JD00000000000000000MMS01", message: "hi", attachment: jpeg },
      sub: { id: sub.id, transport: "sms", endpoint: ep.id }, reservation: { ref: "dlv:01JD00000000000000000MMS01:x", micros: 20_000 }, attempt: 0,
    };
    expect(await processJob(job, E)).toBe("delivered");
    expect(calls[0]!.body.has("MediaUrl")).toBe(false);
  });
});
