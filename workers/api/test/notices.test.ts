import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meterRent } from "../src/cron.ts";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap } from "./helpers.ts";

const E = env as unknown as Env;
const DAY = 86_400_000;
const realFetch = globalThis.fetch;

/** Captures SES sends; `fail` makes the next N sends return 500. */
function stubSes(opts: { fail?: number } = {}) {
  const sent: { to: string; subject: string; text: string }[] = [];
  let fail = opts.fail ?? 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.hostname.endsWith("amazonaws.com")) return realFetch(input, init);
    if (fail > 0) { fail--; return new Response("boom", { status: 500 }); }
    const b = JSON.parse(String(init.body)) as { Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } };
    sent.push({ to: b.Destination.ToAddresses[0]!, subject: b.Content.Simple.Subject.Data, text: b.Content.Simple.Body.Text.Data });
    return Response.json({ MessageId: `m${sent.length}` });
  });
  return sent;
}

async function frozenAccount(handle: string, email: string | null) {
  const a = await bootstrap(handle, 0);
  await E.DB.prepare("UPDATE accounts SET email = ? WHERE id = ?").bind(email, a.account_id).run();
  const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "webhook", address: "https://hooks.example.com/n" }) });
  expect(r.status).toBe(201);
  return a;
}

afterEach(() => vi.unstubAllGlobals());

describe("frozen-account emails", () => {
  it("sends freeze, deletion warning, and deletion notices once each", async () => {
    const sent = stubSes();
    const a = await frozenAccount("notice1", "owner@example.com");
    const t0 = Date.UTC(2027, 0, 1);
    const mine = () => sent.filter((m) => m.to === "owner@example.com");

    await meterRent(E, t0);
    expect(mine().map((m) => m.subject)).toEqual([expect.stringMatching(/frozen/)]);
    expect(mine()[0]!.text).toContain("2027-01-31");
    expect(mine()[0]!.text).toContain("/console/#tab=billing");

    for (let d = 1; d < 23; d++) await meterRent(E, t0 + d * DAY);
    expect(mine()).toHaveLength(1);

    await meterRent(E, t0 + 23 * DAY);
    await meterRent(E, t0 + 24 * DAY);
    expect(mine().map((m) => m.subject)).toEqual([expect.stringMatching(/frozen/), expect.stringMatching(/deleted on 2027-01-31/)]);

    await meterRent(E, t0 + 31 * DAY);
    await meterRent(E, t0 + 32 * DAY);
    expect(mine()).toHaveLength(3);
    expect(mine()[2]!.subject).toMatch(/were deleted/);
    const eps = await E.DB.prepare("SELECT COUNT(*) AS n FROM endpoints WHERE account_id = ?").bind(a.account_id).first<{ n: number }>();
    expect(eps?.n).toBe(0);

    const { results } = await E.DB.prepare("SELECT detail FROM audit_log WHERE account_id = ? AND action = 'account.notice' ORDER BY id").bind(a.account_id).all<{ detail: string }>();
    expect(results.map((r) => JSON.parse(r.detail).kind)).toEqual(["frozen", "deletion_warning", "deleted"]);
  });

  it("retries a failed freeze notice the next day and skips accounts without an email", async () => {
    const sent = stubSes({ fail: 1 });
    await frozenAccount("notice2", "retry@example.com");
    const t0 = Date.UTC(2027, 3, 1);
    await meterRent(E, t0);
    expect(sent.filter((m) => m.to === "retry@example.com")).toHaveLength(0);
    await meterRent(E, t0 + DAY);
    expect(sent.filter((m) => m.to === "retry@example.com")).toHaveLength(1);

    const before = sent.length;
    await frozenAccount("notice3", null);
    await meterRent(E, t0 + 2 * DAY);
    expect(sent.length).toBe(before);
  });
});
