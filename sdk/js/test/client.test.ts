import { describe, expect, it } from "vitest";
import { SubEtha, SubEthaError, webCryptoSigner, type DeviceSigner } from "../src/client.ts";
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

  it("signs envelopes and requests through a custom DeviceSigner, and verifies with verifyEnvelope", async () => {
    const deviceKey = await deviceKeyFromSeed(hexDecode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
    const inner = webCryptoSigner(deviceKey);
    const seen: string[] = [];
    const signer: DeviceSigner = {
      deviceId: deviceKey.deviceId,
      signEnvelope: (env) => (seen.push("env:" + env.topic), inner.signEnvelope(env)),
      signRequest: (method, url, body, headers, now) => {
        seen.push(`req:${method} ${url} ${[...headers].map(([k]) => k).sort().join(",")}`);
        return inner.signRequest(method, url, body, headers, now);
      },
    };
    const { f, calls } = mockFetch((u, init) => new Response(u.endsWith("/") ? (init.body as string) : "{}"));
    const c = new SubEtha({ baseUrl: "https://x.test", fetch: f, signer, signRequests: true, token: "se_t" });
    const sent = await c.publish("@a/b", "hi");
    expect(sent.sender).toBe(deviceKey.deviceId);
    expect(await verifyEnvelope(sent)).toBe(true);
    // Authorization is dropped from signed requests; content-type is signed.
    expect(seen).toEqual(["env:@a/b", "req:POST https://x.test/ content-type"]);
    const h = calls[0]!.init.headers as Headers;
    expect(h.get("x-device-id")).toBe(deviceKey.deviceId);
    expect(h.get("x-device-signed-headers")).toBe("x-device-id,x-device-time,x-device-nonce,content-type");
    expect(h.get("authorization")).toBeNull();

    // subscribe's verify uses the client's verifyEnvelope.
    const checked: string[] = [];
    const lines = [{ ...sent, id: "01A", sig: "ed25519:bogus" }, { ...sent, id: "01B" }].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const { f: f2 } = mockFetch((u) => new Response(u.endsWith("/v1/ack") ? "{}" : lines));
    const c2 = new SubEtha({ baseUrl: "https://x.test", fetch: f2, verifyEnvelope: (e) => (checked.push(e.id!), e.id === "01B") });
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      const sub = c2.subscribe("@a/b", (m) => { got.push(m.id!); sub.close(); resolve(); }, { transport: "poll", verify: true, autoAck: false });
    });
    expect(checked).toEqual(["01A", "01B"]);
    expect(got).toEqual(["01B"]);
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
