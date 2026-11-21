import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deviceKeyFromSeed, hexDecode } from "@subetha/sdk/protocol";
import { enrollmentProof, SubEtha } from "@subetha/sdk";
import { handleInboundEmail, parseEmail, topicFromAddress } from "../src/email-inbound.ts";
import { meterRent } from "../src/cron.ts";
import type { Env } from "../src/types.ts";
import { auth, balance, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;
const rpc = (token: string, method: string, params: Record<string, unknown> = {}, id = 1) =>
  SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: auth(token, { "content-type": "application/json" }), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });

describe("MCP server", () => {
  it("requires auth and advertises protected-resource metadata", async () => {
    const r = await SELF.fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    const meta = await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
    expect(meta).toMatchObject({ resource: expect.stringMatching(/\/mcp$/) });
  });

  it("initializes, lists tools, publishes, polls, estimates, and waits for messages", async () => {
    const a = await bootstrap("agent");
    const init = (await (await rpc(a.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).json()) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(a.token, "notifications/initialized")).status).toBe(202);
    const tools = (await (await rpc(a.token, "tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name)).toEqual(["publish", "poll", "wait_for_message", "list_topics", "create_topic", "estimate_cost"]);

    const call = async (name: string, args: Record<string, unknown>) => ((await (await rpc(a.token, "tools/call", { name, arguments: args })).json()) as { result: { isError: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] } }).result;
    const pub = await call("publish", { topic: "@agent/inbox", message: "hello agent", priority: 4 });
    expect(pub.isError).toBe(false);
    expect(pub.structuredContent).toMatchObject({ message: "hello agent", priority: 4 });
    const polled = await call("poll", { topic: "@agent/inbox" });
    expect((polled.structuredContent.messages as unknown[]).length).toBe(1);
    const est = await call("estimate_cost", { topic: "@agent/inbox" });
    expect(est.structuredContent.estimate_usd_micros).toBeGreaterThan(0);
    expect((await call("list_topics", {})).structuredContent).toMatchObject({ topics: [{ name: "@agent/inbox" }] });

    const waiting = call("wait_for_message", { topic: "@agent/inbox", timeout_s: 5 });
    await new Promise((r) => setTimeout(r, 100));
    await publish("@agent/inbox", "while you waited", auth(a.token));
    const got = await waiting;
    expect((got.structuredContent.message as { message: string }).message).toBe("while you waited");

    const timedOut = await call("wait_for_message", { topic: "@agent/inbox", timeout_s: 1 });
    expect(timedOut.structuredContent).toEqual({ timeout: true });
    const bad = await call("publish", { topic: "nope", message: "x" });
    expect(bad.isError).toBe(true);
  });
});

describe("inbound email", () => {
  it("maps addresses to topics", () => {
    expect(topicFromAddress("alice.doorbell@in.subetha.org")).toBe("@alice/doorbell");
    expect(topicFromAddress("alice.Door_Bell@in.subetha.org")).toBe("@alice/Door_Bell");
    expect(topicFromAddress("t_abcdefghijklmnopqrstuvwxyz@in.subetha.org")).toBe("t_abcdefghijklmnopqrstuvwxyz");
    expect(topicFromAddress("nodot@in.subetha.org")).toBeNull();
  });

  it("parses multipart, quoted-printable, and encoded subjects", () => {
    const raw = [
      "From: Bob <bob@example.com>", "Subject: =?UTF-8?B?w6l0w6kgYWxlcnQ=?=", "Content-Type: multipart/alternative; boundary=\"b1\"", "", "--b1",
      "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "Caf=C3=A9 door is open=", "ed.", "", "On Mon, Bob wrote:", "> old", "--b1",
      "Content-Type: text/html", "", "<p>html</p>", "--b1--", "",
    ].join("\r\n");
    expect(parseEmail(raw)).toEqual({ subject: "été alert", from: "Bob <bob@example.com>", text: "Café door is opened." });
  });

  it("publishes allowed senders' mail and rejects others", async () => {
    const a = await bootstrap("mailin", 1);
    await SELF.fetch(`${BASE}/v1/topics/@mailin/box`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { email_senders: ["bob@example.com"] } }) });
    const fake = (from: string) => {
      const raw = `From: ${from}\r\nSubject: Hi\r\nMessage-ID: <${from}-${Math.random()}>\r\n\r\nhello by mail`;
      let rejected: string | null = null;
      return {
        msg: { from, to: "mailin.box@in.subetha.org", rawSize: raw.length, raw: new Response(raw).body!, headers: new Headers({ "message-id": `<${Math.random()}>` }), setReject: (r: string) => { rejected = r; }, forward: async () => ({}), reply: async () => ({}) } as unknown as ForwardableEmailMessage,
        get rejected() { return rejected; },
      };
    };
    const ok = fake("bob@example.com");
    await handleInboundEmail(ok.msg, E);
    expect(ok.rejected).toBeNull();
    const poll = await SELF.fetch(`${BASE}/@mailin/box/json?poll=1`, { headers: auth(a.token) });
    expect(await poll.text()).toContain('"message":"hello by mail"');
    const no = fake("mallory@example.com");
    await handleInboundEmail(no.msg, E);
    expect(no.rejected).toBe("sender not allowed for this topic");
  });
});

describe("devices", () => {
  it("enrolls via device code and authenticates signed requests", async () => {
    const a = await bootstrap("devowner", 1);
    const key = await deviceKeyFromSeed(hexDecode("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"));
    const code = (await (await SELF.fetch(`${BASE}/v1/device/code`, { method: "POST", body: JSON.stringify({ ...(await enrollmentProof(key)), name: "kitchen esp32", capabilities: ["ble"] }) })).json()) as { device_code: string; user_code: string };
    expect(code.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    const pending = await SELF.fetch(`${BASE}/v1/device/token`, { method: "POST", body: JSON.stringify({ device_code: code.device_code }) });
    expect(((await pending.json()) as { error: string }).error).toBe("authorization_pending");
    expect((await SELF.fetch(`${BASE}/v1/device/approve`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ user_code: code.user_code }) })).status).toBe(200);
    const done = (await (await SELF.fetch(`${BASE}/v1/device/token`, { method: "POST", body: JSON.stringify({ device_code: code.device_code }) })).json()) as { device_id: string };
    expect(done.device_id).toBe(key.deviceId);

    const dev = new SubEtha({ baseUrl: BASE, fetch: SELF.fetch.bind(SELF) as typeof fetch, deviceKey: key, signRequests: true });
    const m = await dev.publish("@devowner/kitchen", "temp 21C", { sign: false });
    expect(m.message).toBe("temp 21C");
    expect((await dev.poll("@devowner/kitchen")).map((x) => x.message)).toEqual(["temp 21C"]);
    await expect(dev.createToken({ scopes: ["admin"] })).rejects.toMatchObject({ code: "forbidden" });

    // Tampering with the body breaks the signature.
    const forged = await SELF.fetch(`${BASE}/@devowner/kitchen`, { method: "POST", body: "x", headers: { "x-device-id": key.deviceId, "x-device-time": String(Math.floor(Date.now() / 1000)), "x-device-signature": "A".repeat(86) } });
    expect(forged.status).toBe(401);

    expect((await SELF.fetch(`${BASE}/v1/devices/${key.deviceId}`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);
    await expect(dev.publish("@devowner/kitchen", "after revoke", { sign: false })).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("cron rent metering", () => {
  it("charges device/endpoint rent daily and freezes accounts that can't pay", async () => {
    const a = await bootstrap("renter", 1);
    await SELF.fetch(`${BASE}/v1/devices`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ device_id: "dev_js22x5vnph57lk54zl6me2oyltjgkhwuxcc3lbu7eqno34ffxiuq" }) });
    const before = await balance(a.token);
    await meterRent(E, Date.UTC(2026, 5, 1));
    expect(await balance(a.token)).toBe(before - 2);
    await meterRent(E, Date.UTC(2026, 5, 1)); // same day: idempotent
    expect(await balance(a.token)).toBe(before - 2);

    const b = await bootstrap("deadbeat", 0);
    await SELF.fetch(`${BASE}/v1/devices`, { method: "POST", headers: auth(b.token), body: JSON.stringify({ device_id: "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena" }) });
    await meterRent(E, Date.UTC(2026, 5, 2));
    const row = await E.DB.prepare("SELECT frozen_since FROM accounts WHERE id = ?").bind(b.account_id).first<{ frozen_since: number }>();
    expect(row?.frozen_since).toBe(Date.UTC(2026, 5, 2));
    await meterRent(E, Date.UTC(2026, 6, 15));
    const dev = await E.DB.prepare("SELECT revoked_at FROM devices WHERE account_id = ?").bind(b.account_id).first<{ revoked_at: number | null }>();
    expect(dev?.revoked_at).not.toBeNull();
  });
});
