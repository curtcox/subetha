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
});
