// Inbound SMS and MMS (PLAN §6): texts from a verified number publish to its endpoint's inbound topic.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionPriceMicros, type PriceTable } from "@subetha/pricing";
import PRICES from "@subetha/pricing/prices.json";
import { fetchInboundMedia, twilioSignature } from "../src/delivery/twilio.ts";
import type { Env } from "../src/types.ts";
import { auth, balance, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;
const P = PRICES as unknown as PriceTable;
const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

const MEDIA = "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Twilio's API: SMS sends succeed; media URLs serve `media` (or 404). */
function stubTwilio(media: { type: string; bytes: Uint8Array } | null = null) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    calls.push({ url, init });
    if (url.includes("/Media/")) return media ? new Response(media.bytes, { headers: { "content-type": media.type } }) : new Response("gone", { status: 404 });
    return new Response(JSON.stringify({ sid: "SM1", num_segments: "1" }), { status: 201 });
  });
  return calls;
}

async function inbound(params: Record<string, string>) {
  const sig = await twilioSignature("twilio-token", "http://localhost:8787/v1/hooks/twilio/sms", params);
  return SELF.fetch(`${BASE}/v1/hooks/twilio/sms`, { method: "POST", body: new URLSearchParams(params), headers: { "x-twilio-signature": sig } });
}

async function phoneWithInbox(handle: string, phone: string) {
  const a = await bootstrap(handle, 5);
  await publish(`@${handle}/texts`, "init", auth(a.token));
  const calls = stubTwilio();
  const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "sms", address: phone }) });
  const ep = (await r.json()) as { id: string };
  const code = /code is (\d{6})/.exec(new URLSearchParams(String(calls[0]!.init.body)).get("Body")!)![1];
  await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}/verify`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ code }) });
  return { a, ep };
}

const latest = async (handle: string, token: string) => {
  const lines = (await (await SELF.fetch(`${BASE}/@${handle}/texts/json?poll=1&since=all`, { headers: auth(token) })).text()).trim().split("\n");
  return JSON.parse(lines.at(-1)!) as { message: string; tags?: string[]; attachment?: { url: string; type: string; size: number; name: string } };
};

describe("PATCH /v1/endpoints/:id", () => {
  it("sets and clears an SMS endpoint's inbound topic (own topics only) and renames endpoints", async () => {
    const { a, ep } = await phoneWithInbox("inboxer", "+14155550161");
    const patch = (body: unknown, token = a.token) => SELF.fetch(`${BASE}/v1/endpoints/${ep.id}`, { method: "PATCH", headers: auth(token), body: JSON.stringify(body) });

    const ok = await patch({ inbound_topic: "@inboxer/texts", name: "My phone" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: ep.id, name: "My phone", inbound_topic: "@inboxer/texts" });

    const other = await bootstrap("notmine", 1);
    await publish("@notmine/x", "init", auth(other.token));
    expect((await patch({ inbound_topic: "@notmine/x" })).status).toBe(403);
    expect((await patch({ inbound_topic: "not a topic!" })).status).toBe(400);
    expect((await patch({ name: "x" }, other.token)).status).toBe(404);

    const cleared = await patch({ inbound_topic: null });
    expect(await cleared.json()).not.toHaveProperty("inbound_topic");

    const webhook = (await (await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/x" }) })).json()) as { id: string };
    expect((await SELF.fetch(`${BASE}/v1/endpoints/${webhook.id}`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ inbound_topic: "@inboxer/texts" }) })).status).toBe(400);
  });
});

describe("inbound texts", () => {
  it("publishes an SMS to the inbound topic, charged as inbound_sms_us", async () => {
    const { a, ep } = await phoneWithInbox("smsin", "+14155550162");
    await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ inbound_topic: "@smsin/texts" }) });
    const before = await balance(a.token);
    expect((await inbound({ From: "+14155550162", Body: "running late", MessageSid: "SMin1", NumMedia: "0" })).status).toBe(200);
    const m = await latest("smsin", a.token);
    expect(m).toMatchObject({ message: "running late", tags: ["sms"] });
    expect(m.attachment).toBeUndefined();
    expect(before - (await balance(a.token))).toBeGreaterThanOrEqual(actionPriceMicros(P, "inbound_sms_us"));
  });

  it("stores an MMS picture as the message's attachment, charged as inbound_mms_us", async () => {
    const { a, ep } = await phoneWithInbox("mmsin", "+14155550163");
    await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ inbound_topic: "@mmsin/texts" }) });
    const calls = stubTwilio({ type: "image/png", bytes: PNG });
    const before = await balance(a.token);
    expect((await inbound({ From: "+14155550163", Body: "", MessageSid: "MMin1", NumMedia: "1", MediaUrl0: MEDIA, MediaContentType0: "image/png" })).status).toBe(200);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    const m = await latest("mmsin", a.token);
    expect(m.message).toBe("You received a file: mms.png");
    expect(m.attachment).toMatchObject({ name: "mms.png", type: "image/png", size: PNG.length });
    expect(before - (await balance(a.token))).toBeGreaterThanOrEqual(actionPriceMicros(P, "inbound_mms_us"));

    vi.unstubAllGlobals();
    const file = await SELF.fetch(m.attachment!.url.replace("http://localhost:8787", BASE));
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  it("falls back to a plain SMS when the media isn't a supported picture", async () => {
    const { a, ep } = await phoneWithInbox("mmsbad", "+14155550164");
    await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ inbound_topic: "@mmsbad/texts" }) });
    stubTwilio({ type: "video/mp4", bytes: PNG });
    await inbound({ From: "+14155550164", Body: "look", MessageSid: "MMin2", NumMedia: "1", MediaUrl0: MEDIA });
    const m = await latest("mmsbad", a.token);
    expect(m).toMatchObject({ message: "look" });
    expect(m.attachment).toBeUndefined();
  });
});

describe("fetchInboundMedia", () => {
  it("only fetches this account's message media on Twilio's API host (it sends credentials)", async () => {
    const calls = stubTwilio({ type: "image/jpeg", bytes: PNG });
    expect(await fetchInboundMedia(E, "https://evil.example.com/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1")).toBeNull();
    expect(await fetchInboundMedia(E, "https://api.twilio.com/2010-04-01/Accounts/ACother/Messages/MM1/Media/ME1")).toBeNull();
    expect(await fetchInboundMedia(E, "not a url")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await fetchInboundMedia(E, MEDIA)).toMatchObject({ type: "image/jpeg", name: "mms.jpg" });
  });
});
