import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const post = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}/`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });

describe("review regressions", () => {
  it("rejects client times that would make retention charges negative or unbounded", async () => {
    const a = await bootstrap("neg");
    await publish("@neg/x", "init", auth(a.token));
    const now = Math.floor(Date.now() / 1000);
    expect((await post(a.token, { topic: "@neg/x", message: "evil", time: 9_000_000_000_000, expires: 0 })).status).toBe(400);
    expect((await post(a.token, { topic: "@neg/x", message: "old", time: now - 30 * 86400 })).status).toBe(400);
    expect((await post(a.token, { topic: "@neg/x", message: "expired", expires: now - 1 })).status).toBe(400);
    const ok = await json(await post(a.token, { topic: "@neg/x", message: "ok", expires: now + 10 * 365 * 86400 }));
    expect(ok.expires as number).toBeLessThanOrEqual(now + 12 * 3600 + 5);
  });

  it("ignores unsigned sender claims for allowed_publishers", async () => {
    const a = await bootstrap("allow");
    const dev = "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena";
    await SELF.fetch(`${BASE}/v1/topics/@allow/x`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { allowed_publishers: [dev] } }) });
    expect((await post(null, { topic: "@allow/x", message: "spoof", sender: dev })).status).toBe(400);
    expect((await post(null, { topic: "@allow/x", message: "anon" })).status).toBe(403);
  });

  it("caps an owner's token on delivery costs it causes, not just the publish", async () => {
    const a = await bootstrap("capped", 5);
    await publish("@capped/x", "init", auth(a.token));
    const ep = await json(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/c" }) }));
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@capped/x", endpoint_id: ep.id }) });
    const t = await json(await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ scopes: ["publish:@capped/x"], daily_cap_usd: 0.00002 }) }));
    expect((await publish("@capped/x", "1", auth(t.token as string))).status).toBe(200); // 6 + 10 µ$
    const second = await publish("@capped/x", "2", auth(t.token as string));
    expect(second.status).toBe(403);
    expect((await json(second)).error).toBe("spend_cap_exceeded");
  });

  it("never drops live deliveries to meet a max cost (they're broadcast anyway)", async () => {
    const a = await bootstrap("maxc");
    await publish("@maxc/x", "init", auth(a.token));
    const sub = await SELF.fetch(`${BASE}/@maxc/x/json`, { headers: auth(a.token) });
    const dry = await json(await publish("@maxc/x", "x", auth(a.token, { "X-Dry-Run": "1", "X-Max-Cost": "0" })));
    expect((dry.plan as unknown[]).length).toBe(1);
    await sub.body!.cancel();
  });

  it("applies tag filters to endpoint subscriptions", async () => {
    const a = await bootstrap("tagf", 5);
    await publish("@tagf/x", "init", auth(a.token));
    const ep = await json(await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/t" }) }));
    await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@tagf/x", endpoint_id: ep.id, filter: { tags: ["alarm"] } }) });
    const plain = await json(await publish("@tagf/x", "x", auth(a.token, { "X-Dry-Run": "1" })));
    expect(plain.plan).toEqual([]);
    const tagged = await json(await publish("@tagf/x", "x", auth(a.token, { "X-Dry-Run": "1", "X-Tags": "alarm,x" })));
    expect((tagged.plan as unknown[]).length).toBe(1);
  });

  it("refuses anonymous dry runs", async () => {
    const a = await bootstrap("anondry");
    await SELF.fetch(`${BASE}/v1/topics/@anondry/x`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { public_publish: true } }) });
    expect((await publish("@anondry/x", "x", { "X-Dry-Run": "1" })).status).toBe(401);
  });
});
