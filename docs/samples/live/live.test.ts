// The TypeScript docs samples, run against a real deployment (PLAN §10: "nightly against
// staging"). Skipped unless SUBETHA_URL and SUBETHA_TOKEN are set:
//
//   SUBETHA_URL=https://staging.subetha.org SUBETHA_TOKEN=se_… SUBETHA_TOPIC=@samples/nightly \
//     pnpm --filter @subetha/samples test:live
//
// The token must be an admin token for an account with a small balance that owns the topic's
// namespace. Each sample gets a fresh topic per run (`<SUBETHA_TOPIC>-<sample>-<run>`), since
// some samples read back the topic's first message. Samples that create billed resources (webhook endpoints,
// enrolled devices, tokens) run only in CI against the local Worker (workers/api/test/samples.test.ts).
import { describe, expect, it } from "vitest";
import type { SampleContext } from "../ts/_context.ts";

const baseUrl = process.env.SUBETHA_URL?.replace(/\/+$/, "");
const token = process.env.SUBETHA_TOKEN;
const topic = process.env.SUBETHA_TOPIC ?? "@samples/nightly";
const runId = Date.now().toString(36);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (name: string): Promise<any> => {
  const mod = (await import(`../ts/${name}.ts`)) as { run(ctx: SampleContext): Promise<unknown> };
  return mod.run({ baseUrl: baseUrl!, token: token!, topic: `${topic}-${name}-${runId}` });
};

describe.skipIf(!baseUrl || !token)(`docs samples against ${baseUrl ?? "(SUBETHA_URL unset)"}`, () => {
  it("publish.ts", async () => {
    const m = await run("publish");
    expect(m.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(m.priority).toBe(4);
  });

  it("publish-fetch.ts", async () => {
    const { msg, cost } = await run("publish-fetch");
    expect(msg.tags).toEqual(["door", "warning"]);
    expect(cost).toBeGreaterThan(0);
  });

  it("subscribe.ts", async () => {
    expect((await run("subscribe")).message).toBe("hello, subscriber");
  });

  it("poll.ts", async () => {
    const msgs = (await run("poll")) as { message: string }[];
    expect(msgs.map((m) => m.message)).toContain("disk 91% full");
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
    expect((await run("signed")).valid).toBe(true);
  });

  it("e2ee.ts", async () => {
    const { plain, wire } = await run("e2ee");
    expect(plain.message).toBe("The door code is 4721");
    expect(wire.message).not.toContain("4721");
  });

  it("topic-policy.ts", async () => {
    expect((await run("topic-policy")).status).toBe(200);
  });

  it("mcp.ts", async () => {
    const r = await run("mcp");
    expect(r.tools).toContain("wait_for_message");
    expect(r.sent.message).toBe("Deploy finished");
    expect(r.inbox.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("attachment.ts", async () => {
    const r = await run("attachment");
    expect(r.status).toBe(200);
    expect(r.downloaded).toContain("2026-11-21,12.9");
  });

  it("trace.ts", async () => {
    expect((await run("trace")).id).toBeTruthy();
  });
});
