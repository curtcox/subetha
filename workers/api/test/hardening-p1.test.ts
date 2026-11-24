import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceKeyFromSeed, signEnvelope, ulid } from "@subetha/sdk/protocol";
import { enrollmentProof } from "@subetha/sdk";
import { assertPublicWebhook } from "../src/control.ts";
import { processJob } from "../src/delivery/consumer.ts";
import { handleInboundEmail, parseEmail } from "../src/email-inbound.ts";
import { accountStub } from "../src/durable/account.ts";
import { topicStub } from "../src/durable/topic.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { auth, balance, BASE, bootstrap, clerkJwt, publish } from "./helpers.ts";

const E = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P1 relay flows, MCP, delivery, and policy hardening", () => {
  it("allows OAuth MCP clients to call list_topics and create_topic while blocking admin routes, and enforces mcp transport policy", async () => {
    const a = await bootstrap("mcpoauth", 5);
    await E.DB.prepare("UPDATE accounts SET clerk_id = ? WHERE id = ?").bind("user_mcpoauth", a.account_id).run();
    const at = await clerkJwt("user_mcpoauth", { typ: "at+jwt", claims: { client_id: "claude", aud: `${BASE}/mcp` } });
    const rpc = (method: string, params: Record<string, unknown>) =>
      SELF.fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: auth(at, { "content-type": "application/json" }),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });

    // create_topic and list_topics succeed with OAuth token.
    const created = (await (await rpc("tools/call", { name: "create_topic", arguments: { topic: "@mcpoauth/tasks", policy: {} } })).json()) as { result: { isError: boolean } };
    expect(created.result.isError).toBe(false);
    const listed = (await (await rpc("tools/call", { name: "list_topics", arguments: {} })).json()) as { result: { isError: boolean; structuredContent: { topics: { name: string }[] } } };
    expect(listed.result.isError).toBe(false);
    expect(listed.result.structuredContent.topics.some((t) => t.name === "@mcpoauth/tasks")).toBe(true);

    // OAuth token still cannot access admin-only endpoints (tokens, billing).
    expect((await SELF.fetch(`${BASE}/v1/tokens`, { headers: auth(at) })).status).toBe(403);

    // Denying mcp transport blocks MCP poll.
    await SELF.fetch(`${BASE}/v1/topics/@mcpoauth/tasks`, {
      method: "PUT",
      headers: auth(a.token),
      body: JSON.stringify({ policy: { deny_transports: ["mcp"] } }),
    });
    const polled = (await (await rpc("tools/call", { name: "poll", arguments: { topic: "@mcpoauth/tasks" } })).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(polled.result.isError).toBe(true);
    expect(polled.result.content[0]!.text).toContain("transport_denied");
  });

  it("re-validates account/topic/subscription pause and acks on retries inside processJob", async () => {
    const a = await bootstrap("jobreval", 5);
    await publish("@jobreval/box", "init", auth(a.token));
    const ep = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "webhook", address: "https://example.com/hook" }),
    })).json()) as { id: string };
    const sub = (await (await SELF.fetch(`${BASE}/v1/subscriptions`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ topic: "@jobreval/box", endpoint_id: ep.id }),
    })).json()) as { id: string };

    // Pause the subscription after queueing: processJob must skip and release the reservation.
    await SELF.fetch(`${BASE}/v1/subscriptions/${sub.id}`, {
      method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: true }),
    });
    const ref1 = `dlv:reval:1:${ulid()}`;
    await accountStub(E, a.account_id).reserve(100, ref1, null, {});
    const beforeBal = await balance(a.token);
    const job1: DeliveryJob = {
      topic: "@jobreval/box", owner: a.account_id,
      message: { topic: "@jobreval/box", id: ulid(), message: "hi" },
      sub: { id: sub.id, transport: "webhook", endpoint: ep.id },
      reservation: { ref: ref1, micros: 100 }, attempt: 0,
    };
    expect(await processJob(job1, E)).toBe("skipped");
    expect(await balance(a.token)).toBe(beforeBal + 100);

    // Resume subscription, ack message, retry job with after_s = 0 and attempt = 1 -> skipped!
    await SELF.fetch(`${BASE}/v1/subscriptions/${sub.id}`, {
      method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: false }),
    });
    const msgId = ulid();
    await topicStub(E, "@jobreval/box").ack(msgId, "ws");
    const ref2 = `dlv:reval:2:${ulid()}`;
    await accountStub(E, a.account_id).reserve(100, ref2, null, {});
    const job2: DeliveryJob = {
      topic: "@jobreval/box", owner: a.account_id,
      message: { topic: "@jobreval/box", id: msgId, message: "hi" },
      sub: { id: sub.id, transport: "webhook", endpoint: ep.id },
      reservation: { ref: ref2, micros: 100 }, attempt: 1,
    };
    expect(await processJob(job2, E)).toBe("skipped");
  });

  it("releases funds and hourly throttle when endpoint verification send fails", async () => {
    const a = await bootstrap("verifyfail", 5);
    const bal0 = await balance(a.token);
    // Email provider is not configured in test env -> sendEmail throws -> endpoint deleted, balance unchanged, throttle released.
    const r1 = await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "email", address: "retry@example.com" }),
    });
    expect(r1.status).toBe(503);
    expect(await balance(a.token)).toBe(bal0);
    // Retrying immediately is NOT blocked by 429 rate_limited (throttle was released).
    const r2 = await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "email", address: "retry@example.com" }),
    });
    expect(r2.status).toBe(503);
  });

  it("prefers text/plain over earlier text/html and rejects SPF/DMARC fail on inbound email", async () => {
    const raw = [
      "Subject: Test",
      "From: alice@example.com",
      'Content-Type: multipart/alternative; boundary="bnd"',
      "",
      "--bnd",
      "Content-Type: text/html",
      "",
      "<p>HTML version</p>",
      "--bnd",
      "Content-Type: text/plain",
      "",
      "Plain version",
      "--bnd--",
    ].join("\r\n");
    expect(parseEmail(raw).text).toBe("Plain version");

    const a = await bootstrap("mailsec", 5);
    await SELF.fetch(`${BASE}/v1/topics/@mailsec/inbox`, {
      method: "PUT", headers: auth(a.token),
      body: JSON.stringify({ policy: { email_senders: ["alice@example.com"] } }),
    });
    let rejected = "";
    await handleInboundEmail({
      from: "alice@example.com",
      to: "mailsec.inbox@in.subetha.us",
      rawSize: raw.length,
      raw: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close(); } }),
      headers: new Headers({ "authentication-results": "mx.cloudflare.net; spf=fail; dmarc=fail" }),
      setReject: (r: string) => { rejected = r; },
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage, E);
    expect(rejected).toContain("SPF/DMARC");
  });

  it("blocks .local/.internal webhook URLs and revoked device signed envelopes", async () => {
    expect(() => assertPublicWebhook("https://metadata.google.internal/v1", BASE)).toThrow();
    expect(() => assertPublicWebhook("https://printer.local/hook", BASE)).toThrow();
    expect(() => assertPublicWebhook("not a url", BASE)).toThrow();

    const a = await bootstrap("revdev", 5);
    const kp = await deviceKeyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const proof = await enrollmentProof(kp);
    expect((await SELF.fetch(`${BASE}/v1/devices`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ ...proof, name: "sensor" }),
    })).status).toBe(201);
    expect((await SELF.fetch(`${BASE}/v1/devices/${kp.deviceId}`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);

    const signed = await signEnvelope({ id: ulid(), time: Math.floor(Date.now() / 1000), topic: "@revdev/box", message: "after-revoke" }, kp);
    const res = await SELF.fetch(`${BASE}/`, {
      method: "POST", headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify(signed),
    });
    expect(res.status).toBe(403);
  });
});
