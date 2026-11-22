// Runs every TypeScript docs sample (docs/samples/ts) against this Worker, so a broken sample
// fails the build (PLAN §10). docs/samples/test checks that each sample is exercised here.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SampleContext } from "../../../docs/samples/ts/_context.ts";
import { signWebhook } from "../src/delivery/webhook.ts";
import { BASE, bootstrap } from "./helpers.ts";

// Samples are imported dynamically so the Worker's typecheck doesn't follow them into the
// browser/Node parts of the SDK (docs/samples typechecks them with DOM types).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sample = { run(ctx: SampleContext): Promise<any>; [k: string]: any };
const sample = (name: string): Promise<Sample> => import(`../../../docs/samples/ts/${name}.ts`);

/**
 * SELF.fetch, except that an abort signal ends the response body instead of aborting the fetch.
 * workerd reports an aborted (or cancelled) service-binding stream as an unhandled rejection even
 * when the caller (here, the SDK closing a subscription) handles it.
 */
const selfFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { signal, ...rest } = init ?? {};
  const r = await SELF.fetch(input as string, rest as RequestInit);
  if (!signal || !r.body) return r;
  const reader = r.body.getReader();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  signal.addEventListener("abort", () => {
    if (stopped) return;
    stopped = true;
    ctrl.close();
  });
  const body = new ReadableStream<Uint8Array>({
    start: (c) => void (ctrl = c),
    async pull(c) {
      const x = await reader.read();
      if (stopped) return;
      if (x.done) c.close();
      else c.enqueue(x.value);
    },
  });
  return new Response(body, r);
}) as unknown as typeof fetch;

let n = 0;
async function context(): Promise<SampleContext> {
  const handle = `sample${++n}`;
  const b = await bootstrap(handle, 5);
  return { baseUrl: BASE, token: b.token, topic: `@${handle}/demo`, fetch: selfFetch };
}

const run = async (name: string) => (await sample(name)).run(await context());

describe("docs samples (TypeScript)", () => {
  it("publish.ts", async () => {
    const m = await run("publish");
    expect(m.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(m.priority).toBe(4);
    expect(m.tags).toEqual(["backup", "white_check_mark"]);
  });

  it("publish-fetch.ts", async () => {
    const { msg, cost } = await run("publish-fetch");
    expect(msg.priority).toBe(4);
    expect(msg.tags).toEqual(["door", "warning"]);
    expect(cost).toBeGreaterThan(0);
  });

  it("subscribe.ts", async () => {
    const m = await run("subscribe");
    expect(m.message).toBe("hello, subscriber");
  });

  it("poll.ts", async () => {
    const msgs = (await run("poll")) as { message: string }[];
    expect(msgs.map((m) => m.message)).toEqual(["disk 91% full"]);
  });

  it("dry-run.ts", async () => {
    const est = await run("dry-run");
    expect(est.dry_run).toBe(true);
    expect(est.estimate_usd_micros).toBeGreaterThan(0);
  });

  it("idempotency.ts", async () => {
    const { a, b } = await run("idempotency");
    expect(b.id).toBe(a.id);
  });

  it("signed.ts", async () => {
    const r = await run("signed");
    expect(r.valid).toBe(true);
    expect(r.sent.sender).toBe(r.deviceId);
  });

  it("e2ee.ts", async () => {
    const { plain, wire } = await run("e2ee");
    expect(plain.message).toBe("The door code is 4721");
    expect(plain.title).toBe("Secret");
    expect(wire.enc?.alg).toBe("xchacha20poly1305");
    expect(wire.title).toBeUndefined();
    expect(wire.message).not.toContain("4721");
  });

  it("edge.ts", async () => {
    const { viaSound, again, seconds, sourceBlocks } = await run("edge");
    expect(viaSound.message).toBe("Door opened");
    expect(viaSound.sig).toMatch(/^ed25519:/);
    expect(again).toEqual([]);
    expect(seconds).toBeLessThan(15);
    expect(sourceBlocks).toBeGreaterThanOrEqual(1);
  });

  it("edge-bridge.ts", async () => {
    const { offline, onRelay } = await run("edge-bridge");
    expect(onRelay.map((m: { message: string }) => m.message)).toEqual(expect.arrayContaining(["Battery low", "Firmware update available"]));
    expect(offline.map((m: { message: string }) => m.message)).toEqual(["Firmware update available"]);
    expect(offline[0].hops).toBe(0);
  });

  it("tokens.ts", async () => {
    expect((await run("tokens")).denied).toBe("forbidden");
  });

  it("topic-policy.ts", async () => {
    expect((await run("topic-policy")).status).toBe(200);
  });

  it("webhook.ts", async () => {
    const { endpoint, subscription } = await run("webhook");
    expect(endpoint.id).toMatch(/^ep_/);
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect(subscription.id).toMatch(/^sub_/);
  });

  it("verify-webhook.ts", async () => {
    const { verifyWebhook, handleWebhook } = await sample("verify-webhook");
    const body = JSON.stringify({ id: "01JD0000000000000000000000", topic: "@a/b", message: "hi" });
    const header = await signWebhook("whsec_test", body);
    expect(await verifyWebhook("whsec_test", header, body)).toBe(true);
    expect(await verifyWebhook("whsec_test", header, body + " ")).toBe(false);
    expect(await verifyWebhook("whsec_other", header, body)).toBe(false);
    expect(await verifyWebhook("whsec_test", await signWebhook("whsec_test", body, 1_000_000), body)).toBe(false);
    const ok = await handleWebhook(new Request("https://example.com/hook", { method: "POST", body, headers: { "x-subetha-signature": header } }), "whsec_test");
    expect(ok.status).toBe(200);
  });

  it("devices.ts", async () => {
    const r = await run("devices");
    expect(r.enrolled).toBe(r.deviceId);
    expect(r.msg.message).toBe("garage door closed");
  });

  it("mcp.ts", async () => {
    const r = await run("mcp");
    expect(r.tools).toContain("wait_for_message");
    expect(r.estimate.estimate_usd_micros).toBeGreaterThan(0);
    expect(r.sent.message).toBe("Deploy finished");
    expect(r.inbox.messages).toHaveLength(1);
  });

  it("attachment.ts", async () => {
    const r = await run("attachment");
    expect(r.status).toBe(200);
    expect(r.msg.attachment).toMatchObject({ name: "energy.csv", type: "text/csv" });
    expect(r.msg.message).toBe("Yesterday's energy report");
    expect(r.downloaded).toContain("2026-11-21,12.9");
  });

  it("trace.ts", async () => {
    const t = await run("trace");
    expect(t.id).toBeTruthy();
    expect(t.cost_micros).toBeDefined();
  });
});
