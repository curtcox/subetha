import { describe, expect, it } from "vitest";
import {
  base64urlEncode,
  estimateForModule,
  intersectPolicies,
  Outbox,
  planDelivery,
  planForEnvelope,
  RelayTransport,
  SubEtha,
  type Envelope,
  type TransportEstimate,
  type TransportModule,
} from "../src/index.ts";
import { main, type Config } from "../src/cli.ts";

describe("Outbox", () => {
  it("enqueues, dedupes, backs off exponentially, persists, and flushes", async () => {
    const ob = new Outbox({ baseMs: 100, maxMs: 500, capacity: 3, maxAttempts: 3 });
    const a = ob.enqueue({ id: "01JD0000000000000000000001", topic: "@a/b", message: "one" }, { nowMs: 1000 });
    // Duplicate id ignored (case-insensitive)
    expect(ob.enqueue({ id: "01jd0000000000000000000001", topic: "@a/b", message: "dup" }, { nowMs: 1000 }).id).toBe(a.id);
    expect(ob.size).toBe(1);

    // Poll at 1000 -> attempt 1, nextAttempt at 1100
    expect(ob.poll(1000)).toHaveLength(1);
    expect(ob.poll(1050)).toHaveLength(0);
    // Poll at 1100 -> attempt 2, nextAttempt at 1300
    expect(ob.poll(1100)[0]!.attempts).toBe(2);

    // JSON persistence roundtrip
    const restored = Outbox.fromJSON(ob.toJSON());
    expect(restored.size).toBe(1);
    expect(restored.poll(1250)).toHaveLength(0);

    // Flush succeeds at 1300 and acks
    const sent: string[] = [];
    const res = await restored.flush(async (e) => { sent.push(e.message!); }, 1300);
    expect(res.sent).toEqual([a.id]);
    expect(sent).toEqual(["one"]);
    expect(restored.size).toBe(0);
  });

  it("evicts oldest on overflow and prunes expired items", () => {
    const ob = new Outbox({ capacity: 2 });
    ob.enqueue({ id: "01JD0000000000000000000001", topic: "@a/b", message: "1" }, { nowMs: 100, expiresMs: 200 });
    ob.enqueue({ id: "01JD0000000000000000000002", topic: "@a/b", message: "2" }, { nowMs: 100, expiresMs: 500 });
    ob.enqueue({ id: "01JD0000000000000000000003", topic: "@a/b", message: "3" }, { nowMs: 100, expiresMs: 500 });
    expect(ob.size).toBe(2);
    expect(ob.toJSON().items.map((i) => i.envelope.message)).toEqual(["2", "3"]);
    expect(ob.prune(600)).toBe(2);
    expect(ob.size).toBe(0);
  });
});

describe("routing & TransportModule", () => {
  const candidates: TransportEstimate[] = [
    { transport: "sms", costUsdMicros: 15_000, latencyMs: 3000 },
    { transport: "ws", costUsdMicros: 1, latencyMs: 50 },
    { transport: "ble", costUsdMicros: 0, latencyMs: 400 },
    { transport: "email", costUsdMicros: 500, latencyMs: 20_000 },
  ];

  it("intersects policy layers and sorts by mode", () => {
    const policy = intersectPolicies([
      { deny: ["email"], maxCostUsdMicros: 20_000 },
      { allow: ["ws", "ble", "sms", "email"], maxCostUsdMicros: 16_000 },
    ]);
    const anyPlan = planDelivery("any", policy, candidates);
    expect(anyPlan.steps.map((s) => s.transport)).toEqual(["ble", "ws", "sms"]);
    expect(anyPlan.dispatch).toBe("sequential");
    expect(anyPlan.worstCaseCostUsdMicros).toBe(15_001);

    const fastPlan = planDelivery("fast", policy, candidates);
    expect(fastPlan.steps.map((s) => s.transport)).toEqual(["ws", "ble", "sms"]);

    const cheapPlan = planDelivery("cheap", policy, candidates);
    expect(cheapPlan.steps.map((s) => s.transport)).toEqual(["ble"]);

    const allPlan = planDelivery("all", policy, candidates);
    expect(allPlan.dispatch).toBe("parallel");
    expect(allPlan.steps.map((s) => s.transport)).toEqual(["ws", "ble", "sms"]);
  });

  it("plans directly from an envelope route block and TransportModule estimates", async () => {
    const env: Envelope = { topic: "@a/b", message: "hi", route: { mode: "fast", deny: ["sms"], max_cost_usd_micros: 1000 } };
    const p = planForEnvelope(env, [], candidates);
    expect(p.steps.map((s) => s.transport)).toEqual(["ws", "ble", "email"]);

    const mod: TransportModule = {
      capabilities: () => ({ kind: "ble", edge: true, direction: "in/out", typicalLatencyMs: 400, supportsE2ee: true }),
      send: async () => ({ transport: "ble", costUsdMicros: 0 }),
      receive: async () => [],
      costEstimate: () => 999,
    };
    const est = await estimateForModule(mod, env);
    expect(est).toEqual({ transport: "ble", costUsdMicros: 0, latencyMs: 400 });

    const client = new SubEtha({
      baseUrl: "https://subetha.test",
      token: "se_test",
      fetch: async () => new Response(JSON.stringify({ id: "01JD0000000000000000000099", topic: "@a/b", message: "hi", estimate_usd_micros: 7 })),
    });
    const relay = new RelayTransport(client);
    expect((await relay.send(env)).id).toBe("01JD0000000000000000000099");
    expect(await relay.costEstimate(env)).toBe(7);
  });
});

describe("CLI extended commands and E2EE", () => {
  it("supports --key E2EE publish, --content-type, --hops, token --deny-transports, whoami, and logout", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let saved: Config = { baseUrl: "https://subetha.test", token: "se_tok" };
    const out: string[] = [];
    const err: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const u = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", path: u.pathname, body });
      if (u.pathname === "/") return new Response(JSON.stringify({ ...body, id: body.id ?? "01JD0000000000000000000001" }));
      if (u.pathname === "/v1/tokens") return new Response(JSON.stringify({ id: "tok1", token: "se_new", scopes: body.scopes }));
      if (u.pathname === "/v1/account") return new Response(JSON.stringify({ id: "acct_1", handle: "alice", tier: "standard", balance_usd_micros: 5_000_000 }));
      return new Response(JSON.stringify({ ok: true }));
    };
    const io = {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      env: {},
      fetch: mockFetch,
      readConfig: async () => saved,
      writeConfig: async (c: Config) => { saved = c; },
    };

    const keyB64 = base64urlEncode(new Uint8Array(32).fill(9));
    expect(await main(["pub", "@alice/secret", "top secret", "--key", keyB64, "--kid", "k9", "--hops", "3", "--content-type", "text/markdown"], io, async () => "")).toBe(0);
    const pubBody = calls[0]!.body as Record<string, unknown>;
    expect(pubBody.enc).toMatchObject({ alg: "xchacha20poly1305", kid: "k9" });
    expect(pubBody.hops).toBe(3);

    expect(await main(["token", "create", "--scopes", "publish:@alice/*", "--deny-transports", "sms,voice"], io, async () => "")).toBe(0);
    expect((calls[1]!.body as Record<string, unknown>).deny_transports).toEqual(["sms", "voice"]);

    expect(await main(["whoami"], io, async () => "")).toBe(0);
    expect(out.at(-1)).toContain("@alice");

    expect(await main(["logout"], io, async () => "")).toBe(0);
    expect(saved.token).toBeUndefined();
    expect(err).toEqual([]);
  });
});
