// Endpoint inspector: POST /v1/endpoints/:id/test (PLAN §10).
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionPriceMicros, type PriceTable } from "@subetha/pricing";
import PRICES from "@subetha/pricing/prices.json";
import { signWebhook } from "../src/delivery/webhook.ts";
import { auth, balance, BASE, bootstrap } from "./helpers.ts";

const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());
const WEBHOOK_PRICE = actionPriceMicros(PRICES as unknown as PriceTable, "deliver_webhook");

function stubOutbound(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

async function webhook(token: string, address = "https://hooks.example.com/in") {
  const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(token), body: JSON.stringify({ kind: "webhook", address }) });
  return (await r.json()) as { id: string; secret: string };
}

const test = (token: string, id: string, body?: unknown) =>
  SELF.fetch(`${BASE}/v1/endpoints/${id}/test`, { method: "POST", headers: auth(token), body: body === undefined ? undefined : JSON.stringify(body) });

interface TestResult {
  result: string;
  error?: string;
  charged_usd_micros: number;
  message: { id: string; topic: string; title: string; message: string; priority: number };
  request: { url: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
}

describe("endpoint inspector", () => {
  it("sends a signed test webhook and shows the exact request and response", async () => {
    const a = await bootstrap("insp1", 1);
    const ep = await webhook(a.token);
    const calls = stubOutbound(() => new Response('{"ok":true}', { status: 202, headers: { "x-receiver": "yes" } }));
    const before = await balance(a.token);
    const r = await test(a.token, ep.id, { title: "Hello", message: "from the inspector", priority: 4 });
    expect(r.status).toBe(200);
    const j = (await r.json()) as TestResult;
    expect(j.result).toBe("delivered");
    expect(j.message).toMatchObject({ topic: "@subetha/inspector", title: "Hello", message: "from the inspector", priority: 4 });
    // What we report is what went over the wire, and the signature verifies with the secret.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.com/in");
    expect(calls[0]!.init.body).toBe(j.request.body);
    expect(j.request.headers).toEqual(calls[0]!.init.headers);
    const sig = j.request.headers["x-subetha-signature"]!;
    expect(sig).toBe(await signWebhook(ep.secret, j.request.body, Number(/t=(\d+)/.exec(sig)![1])));
    expect(JSON.parse(j.request.body).id).toBe(j.message.id);
    expect(j.response).toMatchObject({ status: 202, body: '{"ok":true}', truncated: false });
    expect(j.response.headers["x-receiver"]).toBe("yes");
    expect(j.charged_usd_micros).toBe(WEBHOOK_PRICE);
    expect(await balance(a.token)).toBe(before - WEBHOOK_PRICE);

    const audit = (await (await SELF.fetch(`${BASE}/v1/audit`, { headers: auth(a.token) })).json()) as { entries: { action: string }[] };
    expect(audit.entries.map((e) => e.action)).toContain("endpoint.test");
  });

  it("reports a rejected delivery (still charged) and truncates long responses", async () => {
    const a = await bootstrap("insp2", 1);
    const ep = await webhook(a.token);
    stubOutbound(() => new Response("x".repeat(10_000), { status: 401 }));
    const before = await balance(a.token);
    const j = (await (await test(a.token, ep.id)).json()) as TestResult;
    expect(j.result).toBe("failed");
    expect(j.error).toMatch(/HTTP 401/);
    expect(j.response.status).toBe(401);
    expect(j.response.truncated).toBe(true);
    expect(j.response.body).toHaveLength(4096);
    expect(await balance(a.token)).toBe(before - WEBHOOK_PRICE);
  });

  it("refuses redirects", async () => {
    const a = await bootstrap("insp3", 1);
    const ep = await webhook(a.token);
    stubOutbound(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }));
    const j = (await (await test(a.token, ep.id)).json()) as TestResult;
    expect(j.result).toBe("failed");
    expect(j.error).toMatch(/redirected/);
  });

  it("validates input, ownership, verification, and balance", async () => {
    const a = await bootstrap("insp4", 1);
    const b = await bootstrap("insp5", 1);
    const ep = await webhook(a.token);
    stubOutbound(() => new Response("ok"));
    expect((await test(b.token, ep.id)).status).toBe(404);
    expect((await test(a.token, "ep_missing")).status).toBe(404);
    expect((await test(a.token, ep.id, { topic: "not a topic!" })).status).toBe(400);
    expect((await test(a.token, ep.id, { priority: 9 })).status).toBe(400);
    expect((await test(a.token, ep.id, ["x"])).status).toBe(400);
    const custom = (await (await test(a.token, ep.id, { topic: "@insp4/alerts", tags: ["a"] })).json()) as TestResult;
    expect(custom.message.topic).toBe("@insp4/alerts");

    const poor = await bootstrap("insp6", 0);
    const pep = await webhook(poor.token);
    const r = await test(poor.token, pep.id);
    expect(r.status).toBe(402);
  });
});
