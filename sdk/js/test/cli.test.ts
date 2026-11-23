import { describe, expect, it, vi } from "vitest";
import { main, type Config } from "../src/cli.ts";

function io(env: Record<string, string> = {}) {
  const out: string[] = [], err: string[] = [];
  let cfg: Config = {};
  return { out, err, get cfg() { return cfg; }, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env, readConfig: async () => cfg, writeConfig: async (c: Config) => { cfg = c; } } };
}

describe("CLI", () => {
  it("prints help without a command", async () => {
    const t = io();
    expect(await main([], t.io, async () => "")).toBe(1);
    expect(t.out[0]).toContain("Usage");
  });

  it("publishes with flags", async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => new Response(JSON.stringify({ ...JSON.parse(init.body as string), id: "01JD0000000000000000000001" })));
    vi.stubGlobal("fetch", fetchMock);
    const t = io({ SUBETHA_TOKEN: "se_x", SUBETHA_URL: "https://x.test" });
    expect(await main(["pub", "@me/door", "opened", "now", "-t", "Door", "-p", "high", "--tags", "a,b", "--mode", "all", "--deny", "sms"], t.io, async () => "")).toBe(0);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({ topic: "@me/door", message: "opened now", title: "Door", priority: 4, tags: ["a", "b"], route: { mode: "all", deny: ["sms"] } });
    expect(t.out[0]).toBe("published 01JD0000000000000000000001 to @me/door");
    vi.unstubAllGlobals();
  });

  it("reports API errors with their code", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "insufficient_balance", message: "top up" }), { status: 402 }));
    const t = io();
    expect(await main(["pub", "@me/x", "hi"], t.io, async () => "")).toBe(2);
    expect(t.err[0]).toBe("error: insufficient_balance (402): top up");
    vi.unstubAllGlobals();
  });

  it("logs in and saves the config", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "acct_1", handle: "me", balance_usd_micros: 1500000 })));
    const t = io();
    expect(await main(["login", "se_tok", "--url", "https://x.test"], t.io, async () => "")).toBe(0);
    expect(t.cfg).toEqual({ token: "se_tok", baseUrl: "https://x.test" });
    expect(t.out[0]).toBe("logged in as @me (balance $1.500000)");
    vi.unstubAllGlobals();
  });

  it("enrolls via device-code flow on bare `subetha login` and signs subsequent publishes", async () => {
    let polls = 0;
    let enrolledId = "";
    const seenHeaders: Headers[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/v1/device/code")) {
        const b = JSON.parse(init.body as string) as { device_id: string; name: string; proof: string };
        enrolledId = b.device_id;
        expect(b.name).toBe("my-laptop");
        expect(b.proof).toBeTruthy();
        return new Response(JSON.stringify({ device_code: "dc_1", user_code: "BCDF-GHJK", verification_uri: "https://x.test/console/#device", verification_uri_complete: "https://x.test/console/#device=BCDF-GHJK", interval: 1, expires_in: 600 }));
      }
      if (url.endsWith("/v1/device/token")) {
        polls++;
        if (polls === 1) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
        return new Response(JSON.stringify({ device_id: enrolledId, account_id: "acct_1" }));
      }
      seenHeaders.push(new Headers(init.headers));
      return new Response(JSON.stringify({ ...JSON.parse(init.body as string), id: "01JD0000000000000000000009" }));
    });
    const t = io();
    const richIo = { ...t.io, sleep: async () => {} };
    expect(await main(["login", "--url", "https://x.test", "--name", "my-laptop"], richIo, async () => "")).toBe(0);
    expect(polls).toBe(2);
    expect(t.out[0]).toContain("BCDF-GHJK");
    expect(t.out[1]).toContain(`enrolled device ${enrolledId}`);
    expect(t.cfg.deviceId).toBe(enrolledId);
    expect(t.cfg.deviceSeed).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Subsequent publish uses device signatures, not Bearer auth.
    expect(await main(["pub", "@me/door", "hello"], richIo, async () => "")).toBe(0);
    expect(seenHeaders[0]!.get("x-device-id")).toBe(enrolledId);
    expect(seenHeaders[0]!.get("x-device-signature")).toBeTruthy();
    expect(seenHeaders[0]!.get("authorization")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("uploads a file with --file and supports trace and ack", async () => {
    const calls: { url: string; method?: string; headers?: HeadersInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (url.includes("/v1/traces/")) return new Response(JSON.stringify({ id: "01JD0000000000000000000001", ack: null }));
      if (url.endsWith("/v1/ack")) return new Response(JSON.stringify({ acked: true }));
      return new Response(JSON.stringify({ id: "01JD0000000000000000000002", topic: "@me/pics", message: "snap" }));
    });
    const t = io({ SUBETHA_TOKEN: "se_x", SUBETHA_URL: "https://x.test" });
    const richIo = { ...t.io, readFile: async () => ({ name: "photo.jpg", bytes: new Uint8Array([1, 2, 3]) }) };
    expect(await main(["pub", "@me/pics", "snap", "--file", "/tmp/photo.jpg"], richIo, async () => "")).toBe(0);
    expect(calls[0]!.method).toBe("PUT");
    expect((calls[0]!.headers as Record<string, string>)["x-filename"]).toBe("photo.jpg");
    expect((calls[0]!.headers as Record<string, string>)["content-type"]).toBe("image/jpeg");

    expect(await main(["trace", "@me/pics", "01JD0000000000000000000001"], richIo, async () => "")).toBe(0);
    expect(t.out[1]).toContain("01JD0000000000000000000001");

    expect(await main(["ack", "@me/pics", "01JD0000000000000000000001"], richIo, async () => "")).toBe(0);
    expect(t.out[2]).toBe("acked 01JD0000000000000000000001 on @me/pics");
    vi.unstubAllGlobals();
  });
});

describe("CLI lan", async () => {
  const { startLan } = await import("../src/edge/lan-node.ts");
  it("two CLIs exchange a message over UDP multicast", async () => {
    const port = String(40000 + Math.floor(Math.random() * 10000));
    const rx = io();
    const tx = io();
    const lan = (o: { port?: number }) => ({ ...o, interfaceAddress: "127.0.0.1" });
    const listening = main(["lan", "@me/door", "--for", "2", "--port", port], { ...rx.io, startLan: (n, m, o) => startLan(n, m, lan(o ?? {})) }, async () => "");
    await new Promise((r) => setTimeout(r, 200));
    expect(await main(["lan", "@me/door", "--send", "knock knock", "-t", "Door", "--for", "1", "--port", port], { ...tx.io, startLan: (n, m, o) => startLan(n, m, lan(o ?? {})) }, async () => "")).toBe(0);
    expect(await listening).toBe(0);
    expect(rx.out).toEqual(["@me/door: [Door] knock knock"]);
    expect(rx.err[0]).toMatch(/^lan node [0-9a-f]{16} listening on udp \d+$/);
  });
  it("needs a valid topic and a UDP shim", async () => {
    const t = io();
    expect(await main(["lan", "nope"], t.io, async () => "")).not.toBe(0);
    expect(await main(["lan", "@me/door"], t.io, async () => "")).not.toBe(0);
    expect(t.err.join("\n")).toContain("needs Node");
  });
});
