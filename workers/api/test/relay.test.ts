import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deviceKeyFromSeed, hexDecode, signEnvelope, ulid } from "@subetha/sdk/protocol";
import { signStripePayload } from "../src/stripe.ts";
import { auth, balance, BASE, bootstrap, clerkJwt, publish, readUntil } from "./helpers.ts";

describe("ntfy-compatible publish and poll", () => {
  it("publishes with headers and polls it back; balance is debited", async () => {
    const a = await bootstrap("alice");
    const before = await balance(a.token);
    expect(before).toBe(1_000_000);
    const r = await publish("@alice/doorbell", "Opened", auth(a.token, { "X-Title": "Front door", "X-Priority": "high", "X-Tags": "door,warning" }));
    expect(r.status).toBe(200);
    const msg = (await r.json()) as Record<string, unknown>;
    expect(msg).toMatchObject({ topic: "@alice/doorbell", message: "Opened", title: "Front door", priority: 4, tags: ["door", "warning"], event: "message" });
    expect(msg.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(Number(r.headers.get("x-cost-micros"))).toBeGreaterThan(0);

    const poll = await SELF.fetch(`${BASE}/@alice/doorbell/json?poll=1`, { headers: auth(a.token) });
    expect(poll.status).toBe(200);
    const lines = (await poll.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(msg.id);
    expect(await balance(a.token)).toBeLessThan(before);
  });

  it("supports JSON publishing at / and raw / sse poll formats", async () => {
    const a = await bootstrap("bob");
    const r = await SELF.fetch(`${BASE}/`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ topic: "@bob/x", message: "hi\nthere", priority: "urgent", tags: ["a"] }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { priority: number }).priority).toBe(5);
    const raw = await SELF.fetch(`${BASE}/@bob/x/raw?poll=1`, { headers: auth(a.token) });
    expect(await raw.text()).toBe("hi there\n");
    const sse = await SELF.fetch(`${BASE}/@bob/x/sse?poll=1`, { headers: auth(a.token) });
    expect(await sse.text()).toMatch(/^id: [0-9A-Z]{26}\ndata: \{.*"message":"hi\\nthere".*\}\n\n$/);
  });

  it("accepts Basic auth and ?auth= like ntfy clients", async () => {
    const a = await bootstrap("carol");
    const basic = await publish("@carol/x", "one", { authorization: `Basic ${btoa(":" + a.token)}` });
    expect(basic.status).toBe(200);
    const q = btoa(`Bearer ${a.token}`).replace(/=+$/, "");
    const viaQuery = await SELF.fetch(`${BASE}/@carol/x?auth=${q}`, { method: "PUT", body: "two" });
    expect(viaQuery.status).toBe(200);
  });

  it("filters polls by priority and tags, and merges multiple topics", async () => {
    const a = await bootstrap("dave");
    await publish("@dave/a", "low", auth(a.token, { "X-Priority": "1" }));
    await publish("@dave/a", "high", auth(a.token, { "X-Priority": "5", "X-Tags": "x,y" }));
    await publish("@dave/b", "other", auth(a.token));
    const f = await SELF.fetch(`${BASE}/@dave/a/json?poll=1&priority=5&tags=x`, { headers: auth(a.token) });
    expect((await f.text()).trim().split("\n").map((l) => JSON.parse(l).message)).toEqual(["high"]);
    const m = await SELF.fetch(`${BASE}/@dave/a,@dave/b/json?poll=1`, { headers: auth(a.token) });
    expect((await m.text()).trim().split("\n").map((l) => JSON.parse(l).message).sort()).toEqual(["high", "low", "other"]);
  });

  it("rejects invalid topics, oversize messages, and X-Delay", async () => {
    const a = await bootstrap("erin");
    expect((await publish("@Erin/x", "x", auth(a.token))).status).toBe(400);
    const big = await publish("@erin/x", "x".repeat(5000), auth(a.token));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toBe("message_too_large");
    expect((await publish("@erin/x", "x", auth(a.token, { "X-Delay": "10m" }))).status).toBe(400);
  });
});

describe("payment and authorization", () => {
  it("returns 402 with the shortfall when the balance is empty", async () => {
    const a = await bootstrap("broke", 0);
    const r = await publish("@broke/x", "hi", auth(a.token));
    expect(r.status).toBe(402);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("insufficient_balance");
  });

  it("rejects anonymous publishes to unowned topics with 402 and to private topics with 403", async () => {
    expect((await publish("@nobody/x", "hi")).status).toBe(402);
    const a = await bootstrap("frank");
    await publish("@frank/door", "init", auth(a.token));
    const r = await publish("@frank/door", "anon");
    expect(r.status).toBe(403);
  });

  it("lets owners open a topic to anonymous publishing, charged to the owner", async () => {
    const a = await bootstrap("gina");
    const put = await SELF.fetch(`${BASE}/v1/topics/@gina/bell`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { public_publish: true, anon_rate_per_min: 2 } }) });
    expect(put.status).toBe(201);
    const before = await balance(a.token);
    expect((await publish("@gina/bell", "ding")).status).toBe(200);
    expect(await balance(a.token)).toBeLessThan(before);
    expect((await publish("@gina/bell", "ding")).status).toBe(200);
    expect((await publish("@gina/bell", "ding")).status).toBe(429);
  });

  it("enforces token scopes and daily spend caps", async () => {
    const a = await bootstrap("hank", 5);
    const mk = await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ name: "door", scopes: ["publish:@hank/door"], daily_cap_usd: 0.00001 }) });
    expect(mk.status).toBe(201);
    const { token } = (await mk.json()) as { token: string };
    expect((await publish("@hank/other", "x", auth(token))).status).toBe(403);
    expect((await publish("@hank/door", "1", auth(token))).status).toBe(200);
    const capped = await publish("@hank/door", "2", auth(token));
    expect(capped.status).toBe(403);
    expect(((await capped.json()) as { error: string }).error).toBe("spend_cap_exceeded");
    // Subscribe scope missing.
    expect((await SELF.fetch(`${BASE}/@hank/door/json?poll=1`, { headers: auth(token) })).status).toBe(403);
    // Revocation.
    const list = (await (await SELF.fetch(`${BASE}/v1/tokens`, { headers: auth(a.token) })).json()) as { tokens: { id: string; name: string }[] };
    const id = list.tokens.find((t) => t.name === "door")!.id;
    expect((await SELF.fetch(`${BASE}/v1/tokens/${id}`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);
    expect((await publish("@hank/door", "3", auth(token))).status).toBe(401);
  });

  it("can't create topics in someone else's namespace", async () => {
    const a = await bootstrap("ivan");
    await bootstrap("judy");
    expect((await publish("@judy/x", "hi", auth(a.token))).status).toBe(402);
    expect((await SELF.fetch(`${BASE}/v1/topics/@judy/y`, { method: "PUT", headers: auth(a.token), body: "{}" })).status).toBe(403);
  });

  it("dry-run estimates without storing, and idempotency keys dedupe", async () => {
    const a = await bootstrap("kim");
    const dry = await publish("@kim/x", "hi", auth(a.token, { "X-Dry-Run": "1" }));
    expect(dry.status).toBe(200);
    const body = (await dry.json()) as { dry_run: boolean; estimate_usd_micros: number };
    expect(body.dry_run).toBe(true);
    expect(body.estimate_usd_micros).toBeGreaterThan(0);
    const poll = await SELF.fetch(`${BASE}/@kim/x/json?poll=1`, { headers: auth(a.token) });
    expect(await poll.text()).toBe("");

    const one = await publish("@kim/x", "hi", auth(a.token, { "Idempotency-Key": "k1" }));
    const two = await publish("@kim/x", "hi", auth(a.token, { "Idempotency-Key": "k1" }));
    expect(((await one.json()) as { id: string }).id).toBe(((await two.json()) as { id: string }).id);
    expect(two.headers.get("x-duplicate")).toBe("1");
    expect((await publish("@kim/x", "different", auth(a.token, { "Idempotency-Key": "k1" }))).status).toBe(409);
  });

  it("secret t_ topics are created by any account and readable by name", async () => {
    const a = await bootstrap("lee");
    const topic = "t_" + "abcdefghijklmnopqrstuvwxyz";
    expect((await publish(topic, "psst", auth(a.token))).status).toBe(200);
    const anonPoll = await SELF.fetch(`${BASE}/${topic}/json?poll=1`);
    expect(anonPoll.status).toBe(200);
    expect(await anonPoll.text()).toContain("psst");
  });
});

describe("signatures", () => {
  it("requires and verifies device signatures when the policy says so", async () => {
    const a = await bootstrap("mia");
    await SELF.fetch(`${BASE}/v1/topics/@mia/secure`, { method: "PUT", headers: auth(a.token), body: JSON.stringify({ policy: { require_signature: true } }) });
    expect((await publish("@mia/secure", "unsigned", auth(a.token))).status).toBe(401);
    const key = await deviceKeyFromSeed(hexDecode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
    const signed = await signEnvelope({ id: ulid(), time: Math.floor(Date.now() / 1000), topic: "@mia/secure", message: "signed" }, key);
    const ok = await SELF.fetch(`${BASE}/`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify(signed) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { sender: string }).sender).toBe(key.deviceId);
    const tampered = await SELF.fetch(`${BASE}/`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ ...signed, id: ulid(), message: "evil" }) });
    expect(tampered.status).toBe(401);
  });
});

describe("live subscriptions", () => {
  it("streams new messages over SSE", async () => {
    const a = await bootstrap("nina");
    await publish("@nina/live", "first", auth(a.token));
    const sub = await SELF.fetch(`${BASE}/@nina/live/sse`, { headers: auth(a.token) });
    expect(sub.status).toBe(200);
    expect(sub.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(() => void publish("@nina/live", "second", auth(a.token)), 50);
    const text = await readUntil(sub.body!, (t) => t.includes("second"));
    expect(text).toContain("event: open");
    expect(text).not.toContain("first");
    expect(text).toContain('"message":"second"');
  });

  it("streams over WebSocket and accepts acks", async () => {
    const a = await bootstrap("omar");
    await publish("@omar/ws", "backlog", auth(a.token));
    const r = await SELF.fetch(`${BASE}/@omar/ws/ws?since=all`, { headers: auth(a.token, { upgrade: "websocket" }) });
    if (r.status !== 101) throw new Error(`${r.status} ${await r.text()}`);
    const ws = r.webSocket!;
    ws.accept();
    const got: Record<string, unknown>[] = [];
    const done = new Promise<void>((res) => ws.addEventListener("message", (e) => {
      got.push(JSON.parse(e.data as string));
      if (got.some((m) => m.message === "live")) res();
    }));
    await new Promise((res) => setTimeout(res, 20));
    await publish("@omar/ws", "live", auth(a.token));
    await done;
    expect(got.map((m) => m.event)).toEqual(["open", "message", "message"]);
    const live = got.find((m) => m.message === "live")!;
    ws.send(JSON.stringify({ event: "ack", id: live.id }));
    await new Promise((res) => setTimeout(res, 50));
    const trace = await SELF.fetch(`${BASE}/v1/traces/${live.id}?topic=@omar/ws`, { headers: auth(a.token) });
    expect(trace.status).toBe(200);
    const t = (await trace.json()) as { ack: { via: string } | null; plan: unknown[] };
    expect(t.ack?.via).toBe("ws");
    expect(t.plan).toHaveLength(1);
    ws.close();
  });
});

describe("Stripe top-ups", () => {
  it("credits the balance once per checkout session, net of the fee", async () => {
    const a = await bootstrap("pat", 0);
    const evt = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_1", payment_status: "paid", amount_total: 2000, metadata: { account_id: a.account_id } } } };
    const payload = JSON.stringify(evt);
    const sig = await signStripePayload(payload, "whsec_test");
    const r = await SELF.fetch(`${BASE}/v1/hooks/stripe`, { method: "POST", body: payload, headers: { "stripe-signature": sig } });
    expect(r.status).toBe(200);
    expect(await balance(a.token)).toBe(20_000_000 - 1_250_000);
    const again = await SELF.fetch(`${BASE}/v1/hooks/stripe`, { method: "POST", body: payload, headers: { "stripe-signature": sig } });
    expect(((await again.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(await balance(a.token)).toBe(20_000_000 - 1_250_000);
    const bad = await SELF.fetch(`${BASE}/v1/hooks/stripe`, { method: "POST", body: payload, headers: { "stripe-signature": "t=1,v1=00" } });
    expect(bad.status).toBe(401);
    const ledger = (await (await SELF.fetch(`${BASE}/v1/ledger`, { headers: auth(a.token) })).json()) as { entries: { kind: string }[] };
    expect(ledger.entries.map((e) => e.kind)).toContain("topup");
  });
});

describe("Clerk accounts", () => {
  it("creates an account from a Clerk session and claims a handle", async () => {
    const jwt = await clerkJwt("user_123");
    expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(jwt) })).status).toBe(404);
    const c = await SELF.fetch(`${BASE}/v1/account`, { method: "POST", headers: auth(jwt), body: JSON.stringify({ handle: "quinn" }) });
    expect(c.status).toBe(201);
    const me = await SELF.fetch(`${BASE}/v1/account`, { headers: auth(jwt) });
    expect(((await me.json()) as { handle: string }).handle).toBe("quinn");
    expect((await SELF.fetch(`${BASE}/v1/account`, { method: "POST", headers: auth(await clerkJwt("user_456")), body: JSON.stringify({ handle: "quinn" }) })).status).toBe(409);
    expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(await clerkJwt("user_123", { exp: 1 })) })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(await clerkJwt("user_123", { iss: "https://evil" })) })).status).toBe(401);
  });
});
