import { describe, expect, it } from "vitest";
import { SubEtha, SubEthaError } from "../src/client.ts";
import { deviceKeyFromSeed, hexDecode, verifyEnvelope } from "../src/protocol/index.ts";

type Call = { url: string; init: RequestInit };
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { f, calls };
}

describe("SubEtha client", () => {
  it("publishes JSON with auth, idempotency, and route options", async () => {
    const { f, calls } = mockFetch((_u, init) => new Response(init.body as string, { status: 200 }));
    const c = new SubEtha({ baseUrl: "https://x.test/", token: "se_t", fetch: f });
    const m = await c.publish("@a/b", "hi", { title: "T", priority: 3, tags: ["x"], route: { mode: "fast", maxCostUsd: 0.02, deny: ["sms"] }, idempotencyKey: "k" });
    expect(calls[0]!.url).toBe("https://x.test/");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer se_t");
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("k");
    expect(m).toEqual({ topic: "@a/b", message: "hi", title: "T", tags: ["x"], route: { mode: "fast", max_cost_usd_micros: 20000, deny: ["sms"] } });
  });

  it("signs and encrypts when configured, and decrypts on poll", async () => {
    const deviceKey = await deviceKeyFromSeed(hexDecode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
    const key = crypto.getRandomValues(new Uint8Array(32));
    let stored = "";
    const { f } = mockFetch((u, init) => {
      if (u.endsWith("/")) { stored = init.body as string; return new Response(stored); }
      return new Response(stored + "\n");
    });
    const c = new SubEtha({ baseUrl: "https://x.test", fetch: f, deviceKey, topicKeys: { "@a/b": { kid: "k1", key } } });
    const sent = await c.publish("@a/b", "secret", { title: "shh" });
    expect(sent.message).not.toBe("secret");
    expect(sent.title).toBeUndefined();
    expect(sent.sender).toBe(deviceKey.deviceId);
    expect(await verifyEnvelope(sent)).toBe(true);
    const [got] = await c.poll("@a/b");
    expect(got).toMatchObject({ message: "secret", title: "shh" });
  });

  it("raises SubEthaError with the machine-readable code", async () => {
    const { f } = mockFetch(() => new Response(JSON.stringify({ error: "insufficient_balance", http: 402, message: "no money", shortfall_usd_micros: 5 }), { status: 402 }));
    const c = new SubEtha({ fetch: f });
    const e = await c.publish("@a/b", "x").catch((err) => err);
    expect(e).toBeInstanceOf(SubEthaError);
    expect(e.code).toBe("insufficient_balance");
    expect(e.body.shortfall_usd_micros).toBe(5);
  });

  it("subscribes over a JSON stream, dedupes, resumes from the last id, and acks", async () => {
    let n = 0;
    const urls: string[] = [];
    const acks: string[] = [];
    const { f } = mockFetch((u, init) => {
      if (u.endsWith("/v1/ack")) { acks.push(JSON.parse(init.body as string).id); return new Response("{}"); }
      urls.push(u);
      n++;
      const lines = n === 1
        ? ['{"event":"open","topic":"@a/b"}', '{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one","event":"message"}', '{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one","event":"message"}']
        : ['{"event":"open","topic":"@a/b"}', '{"id":"01JD0000000000000000000002","topic":"@a/b","message":"two","event":"message"}'];
      return new Response(lines.join("\n") + "\n");
    });
    const c = new SubEtha({ baseUrl: "https://x.test", fetch: f, WebSocket: undefined });
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      const sub = c.subscribe("@a/b", (m) => {
        got.push(m.message!);
        if (got.length === 2) { sub.close(); resolve(); }
      }, { transport: "stream" });
    });
    expect(got).toEqual(["one", "two"]);
    expect(urls[1]).toContain("since=01JD0000000000000000000001");
    await new Promise((r) => setTimeout(r, 10));
    expect(acks).toContain("01JD0000000000000000000001");
  });
});
