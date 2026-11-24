import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceKeyFromSeed, signEnvelope, ulid } from "@subetha/sdk/protocol";
import { checkProviderDivergence, CIRCUIT_KEY, meterRent } from "../src/cron.ts";
import { accountStub } from "../src/durable/account.ts";
import { topicStub } from "../src/durable/topic.ts";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P0 security, billing, and durability regressions", () => {
  it("rejects oversized JSON publish bodies on POST / with 413", async () => {
    const a = await bootstrap("bigjson", 1);
    const r = await SELF.fetch(`${BASE}/`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ topic: "@bigjson/box", message: "ok", junk: "x".repeat(32_768) }),
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toBe("message_too_large");
  });

  it("prevents a capped/restricted admin token from minting a less-restricted token", async () => {
    const a = await bootstrap("tokesc", 5);
    const restricted = await SELF.fetch(`${BASE}/v1/tokens`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({
        name: "capped-admin",
        scopes: ["admin"],
        daily_cap_usd: 1,
        total_cap_usd: 5,
        transports: ["ws", "webhook"],
        deny_transports: ["sms"],
        expires_in_s: 3600,
      }),
    });
    expect(restricted.status).toBe(201);
    const { token: childAdmin } = (await restricted.json()) as { token: string };

    // Attempting to drop daily_cap_usd, raise cap, drop deny_transports, widen transports, or drop expiry must fail with 403.
    const tries = [
      { scopes: ["admin"] },
      { scopes: ["admin"], daily_cap_usd: 2, total_cap_usd: 5, transports: ["ws"], deny_transports: ["sms"], expires_in_s: 1800 },
      { scopes: ["admin"], daily_cap_usd: 1, total_cap_usd: 10, transports: ["ws"], deny_transports: ["sms"], expires_in_s: 1800 },
      { scopes: ["admin"], daily_cap_usd: 1, total_cap_usd: 5, transports: ["ws", "email"], deny_transports: ["sms"], expires_in_s: 1800 },
      { scopes: ["admin"], daily_cap_usd: 1, total_cap_usd: 5, transports: ["ws"], expires_in_s: 1800 },
      { scopes: ["admin"], daily_cap_usd: 1, total_cap_usd: 5, transports: ["ws"], deny_transports: ["sms"], expires_in_s: 7200 },
    ];
    for (const body of tries) {
      const r = await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(childAdmin), body: JSON.stringify(body) });
      expect(r.status).toBe(403);
    }

    // Narrowing restrictions succeeds.
    const ok = await SELF.fetch(`${BASE}/v1/tokens`, {
      method: "POST",
      headers: auth(childAdmin),
      body: JSON.stringify({
        scopes: ["publish:@tokesc/*"],
        daily_cap_usd: 0.5,
        total_cap_usd: 2,
        transports: ["ws"],
        deny_transports: ["sms", "voice"],
        expires_in_s: 600,
      }),
    });
    expect(ok.status).toBe(201);
  });

  it("does not freeze a funded paused account during daily rent metering", async () => {
    const a = await bootstrap("pausedrent", 5);
    await E.DB.prepare("INSERT INTO endpoints (id, account_id, kind, address, config, verified_at, created_at) VALUES (?, ?, 'webhook', 'https://example.com/hook', '{}', ?, ?)")
      .bind("ep_pausedrent", a.account_id, Date.now(), Date.now()).run();
    const p = await SELF.fetch(`${BASE}/v1/account`, {
      method: "PATCH",
      headers: auth(a.token),
      body: JSON.stringify({ paused: true, daily_cap_micros: 0 }),
    });
    expect(p.status).toBe(200);

    await meterRent(E, Date.now());
    const row = await E.DB.prepare("SELECT frozen_since FROM accounts WHERE id = ?").bind(a.account_id).first<{ frozen_since: number | null }>();
    expect(row?.frozen_since).toBeNull();
  });

  it("enforces account pause immediately on topics that already hold credit leases", async () => {
    const a = await bootstrap("pauselease", 5);
    await publish("@pauselease/box", "before", auth(a.token));
    await SELF.fetch(`${BASE}/v1/topics/@pauselease/box`, {
      method: "PUT",
      headers: auth(a.token),
      body: JSON.stringify({ policy: { public_publish: true } }),
    });
    // Anonymous publish takes a 1¢ credit lease into TopicDO.
    expect((await publish("@pauselease/box", "anon-ok")).status).toBe(200);

    // Pause the account: TopicDO must immediately reject publishes and polls with 403 topic_paused, not burn the lease.
    expect((await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: true }) })).status).toBe(200);
    const anonBlocked = await publish("@pauselease/box", "anon-blocked");
    expect(anonBlocked.status).toBe(403);
    expect(((await anonBlocked.json()) as { error: string }).error).toBe("topic_paused");

    const pollBlocked = await SELF.fetch(`${BASE}/@pauselease/box/json?poll=1`, { headers: auth(a.token) });
    expect(pollBlocked.status).toBe(403);
    expect(((await pollBlocked.json()) as { error: string }).error).toBe("topic_paused");
  });

  it("supports lowercase ULIDs on signed messages for dedupe, since, and traces", async () => {
    const a = await bootstrap("lowulid", 5);
    const kp = await deviceKeyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const lowerId = ulid().toLowerCase();
    const envSigned = await signEnvelope({
      id: lowerId,
      time: Math.floor(Date.now() / 1000),
      topic: "@lowulid/box",
      message: "signed-lower",
    }, kp);

    const r1 = await SELF.fetch(`${BASE}/`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify(envSigned),
    });
    expect(r1.status).toBe(200);

    // Duplicate returns 200 with x-duplicate=1 instead of 409.
    const r2 = await SELF.fetch(`${BASE}/`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify(envSigned),
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-duplicate")).toBe("1");

    // Trace lookup works case-insensitively.
    const tr = await SELF.fetch(`${BASE}/v1/traces/${lowerId}?topic=${encodeURIComponent("@lowulid/box")}`, { headers: auth(a.token) });
    expect(tr.status).toBe(200);

    // since=<lowerId> does not replay the message itself.
    const poll = await SELF.fetch(`${BASE}/@lowulid/box/json?poll=1&since=${lowerId}`, { headers: auth(a.token) });
    expect(poll.status).toBe(200);
    expect((await poll.text()).trim()).toBe("");
  });

  it("handles X-Attach + X-Filename without uploading an R2 object, and enforces topic daily cap on owner publishes", async () => {
    const a = await bootstrap("capowner", 5);
    const att = await SELF.fetch(`${BASE}/@capowner/box`, {
      method: "POST",
      headers: auth(a.token, { "X-Attach": "https://example.com/photo.jpg", "X-Filename": "snap.jpg" }),
      body: "look",
    });
    expect(att.status).toBe(200);
    const attJson = (await att.json()) as { attachment?: { name: string; url: string } };
    expect(attJson.attachment).toEqual({ name: "snap.jpg", url: "https://example.com/photo.jpg" });
    const fileCount = await E.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE topic = '@capowner/box'").first<{ n: number }>();
    expect(fileCount?.n).toBe(0);

    // Set a tiny topic daily cap (10 µ$): 2nd publish (total 12+ µ$) must be rejected even with 0 subscribers.
    await SELF.fetch(`${BASE}/v1/topics/@capowner/capped`, {
      method: "PUT",
      headers: auth(a.token),
      body: JSON.stringify({ policy: { daily_cap_micros: 10 } }),
    });
    expect((await publish("@capowner/capped", "one", auth(a.token))).status).toBe(200);
    const second = await publish("@capowner/capped", "two", auth(a.token));
    expect(second.status).toBe(403);
    expect(((await second.json()) as { error: string }).error).toBe("spend_cap_exceeded");
  });

  it("excludes non-telephony settle rows, email verify charges, and fixed Twilio phonenumber fees from divergence check", async () => {
    const now = Date.UTC(2026, 10, 22, 3, 17);
    const yestNoon = Date.UTC(2026, 10, 21, 12, 0);
    await E.CACHE.delete(CIRCUIT_KEY);
    // $1.00 SMS reserve + $0.20 release => $0.80 telephony revenue.
    // $5.00 webhook reserve + $5.00 release => must be ignored.
    // $2.00 email verify => must be ignored.
    await E.DB.batch([
      E.DB.prepare("INSERT INTO ledger_journal (account_id, seq, kind, amount, ref, available_after, reserved_after, time, meta) VALUES ('acct_d2', 1, 'reserve', -1000000, 'dlv:s1', 0, 0, ?, 'sku=deliver_sms_us')").bind(yestNoon),
      E.DB.prepare("INSERT INTO ledger_journal (account_id, seq, kind, amount, ref, available_after, reserved_after, time, meta) VALUES ('acct_d2', 2, 'settle', 200000, 'dlv:s1', 0, 0, ?, 'charged=800000')").bind(yestNoon + 1000),
      E.DB.prepare("INSERT INTO ledger_journal (account_id, seq, kind, amount, ref, available_after, reserved_after, time, meta) VALUES ('acct_d2', 3, 'reserve', -5000000, 'dlv:w1', 0, 0, ?, 'sku=deliver_webhook')").bind(yestNoon),
      E.DB.prepare("INSERT INTO ledger_journal (account_id, seq, kind, amount, ref, available_after, reserved_after, time, meta) VALUES ('acct_d2', 4, 'settle', 5000000, 'dlv:w1', 0, 0, ?, 'charged=0')").bind(yestNoon + 1000),
      E.DB.prepare("INSERT INTO ledger_journal (account_id, seq, kind, amount, ref, available_after, reserved_after, time, meta) VALUES ('acct_d2', 5, 'reserve', -2000000, 'verify:e1', 0, 0, ?, 'sku=deliver_email')").bind(yestNoon),
    ]);
    const envTwilio = { ...E, TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok" } as Env;
    // Twilio reports $0.50 SMS + $10.00 monthly phonenumbers fee + $10.50 totalprice -> only $0.50 counts -> healthy vs $0.80 revenue!
    vi.stubGlobal("fetch", async () => Response.json({
      usage_records: [
        { category: "sms", price: "0.50" },
        { category: "phonenumbers", price: "10.00" },
        { category: "totalprice", price: "10.50" },
      ],
    }));
    const res = await checkProviderDivergence(envTwilio, now);
    expect(res).toEqual({ tripped: false, twilioMicros: 500_000, revenueMicros: 800_000 });
    expect(await E.CACHE.get(CIRCUIT_KEY)).toBeNull();
    // Silence unused imports if helper unused
    expect(typeof accountStub).toBe("function");
    expect(typeof topicStub).toBe("function");
  });
});
