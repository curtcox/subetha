import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processJob } from "../src/delivery/consumer.ts";
import { topicStub } from "../src/durable/topic.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { auth, balance, BASE, bootstrap, publish } from "./helpers.ts";
import { reserve } from "./reserve.ts";

const E = env as unknown as Env;
afterEach(() => vi.unstubAllGlobals());

describe("escalation", () => {
  it("plans WS → push → SMS → voice for urgent messages, and skips later steps once acked", async () => {
    const a = await bootstrap("alarm", 10);
    await publish("@alarm/smoke", "init", auth(a.token));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(BASE)) return SELF.fetch(input, init);
      return new Response(JSON.stringify({ sid: "SM1", num_segments: "1", MessageId: "x" }), { status: 201 });
    });
    const mk = async (body: Record<string, unknown>) => (await (await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify(body) })).json()) as { id: string };
    const hook = await mk({ kind: "webhook", address: "https://hooks.example.com/a" });
    const sms = await mk({ kind: "sms", address: "+14155550100" });
    // Verify the SMS endpoint directly (the code went to the stubbed provider).
    await E.DB.prepare("UPDATE endpoints SET verified_at = ? WHERE id = ?").bind(Date.now(), sms.id).run();
    const voice = await mk({ kind: "webhook", address: "https://hooks.example.com/voice-stand-in" });
    for (const [ep, after, minp] of [[hook.id, 0, undefined], [sms.id, 60, 4], [voice.id, 300, 5]] as const) {
      const r = await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic: "@alarm/smoke", endpoint_id: ep, after_s: after, min_priority: minp }) });
      expect(r.status).toBe(201);
    }

    const low = (await (await publish("@alarm/smoke", "test", auth(a.token, { "X-Dry-Run": "1" }))).json()) as { plan: { transport: string }[] };
    expect(low.plan.map((d) => d.transport)).toEqual(["webhook"]);
    const urgent = (await (await publish("@alarm/smoke", "SMOKE", auth(a.token, { "X-Dry-Run": "1", "X-Priority": "5" }))).json()) as { plan: { transport: string; after_s: number }[] };
    expect(urgent.plan.map((d) => [d.transport, d.after_s])).toEqual([["webhook", 0], ["sms", 60], ["webhook", 300]]);

    const msg = (await (await publish("@alarm/smoke", "SMOKE", auth(a.token, { "X-Priority": "5" }))).json()) as { id: string };
    await topicStub(E, "@alarm/smoke").ack(msg.id, "ws");
    const ref = await reserve(E, a.account_id, 20_000);
    const before = await balance(a.token);
    const job: DeliveryJob = { topic: "@alarm/smoke", owner: a.account_id, message: { topic: "@alarm/smoke", id: msg.id, message: "SMOKE", priority: 5 }, sub: { id: "s", transport: "sms", endpoint: sms.id, after_s: 60 }, reservation: { ref, micros: 20_000 }, attempt: 0 };
    expect(await processJob(job, E)).toBe("skipped");
    expect(await balance(a.token)).toBe(before + 20_000);

    // X-Deadline drops escalation steps scheduled at or after the deadline from the plan.
    const withDeadline = (await (await publish("@alarm/smoke", "SMOKE", auth(a.token, { "X-Dry-Run": "1", "X-Priority": "5", "X-Deadline": "120" }))).json()) as { plan: { transport: string; after_s: number }[] };
    expect(withDeadline.plan.map((d) => [d.transport, d.after_s])).toEqual([["webhook", 0], ["sms", 60]]);

    // A queued job that arrives after its deadline is skipped and its reservation is released.
    const ref2 = await reserve(E, a.account_id, 15_000);
    const before2 = await balance(a.token);
    const lateJob: DeliveryJob = {
      topic: "@alarm/smoke", owner: a.account_id,
      message: { topic: "@alarm/smoke", id: msg.id, message: "SMOKE", priority: 5 },
      sub: { id: "s2", transport: "webhook", endpoint: hook.id },
      reservation: { ref: ref2, micros: 15_000 },
      attempt: 0,
      deadline_ms: Date.now() - 1_000,
    };
    expect(await processJob(lateJob, E)).toBe("skipped");
    expect(await balance(a.token)).toBe(before2 + 15_000);
  });
});
