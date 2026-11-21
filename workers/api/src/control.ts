// Control plane for endpoints (verified destinations), subscriptions (topic → endpoint), and
// inbound provider hooks (Twilio, Slack). PLAN §6, §9, §11.
import type { Context, Hono } from "hono";
import { isTopic, ulid, type Transport } from "@subetha/sdk/protocol";
import { actionPriceMicros, skuForTransport, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { audit } from "./accounts.ts";
import { requireAccount, requireAdmin } from "./auth.ts";
import { randomBase32, randomDigits, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { accountStub } from "./durable/account.ts";
import { topicStub } from "./durable/topic.ts";
import { ApiError, unwrap } from "./errors.ts";
import { EMAIL_RE, sendEmail } from "./delivery/email.ts";
import { verifySlackSignature } from "./delivery/slack.ts";
import { ackToken, makeCall, sendSms, US_E164, verifyTwilioSignature, voiceTwiml } from "./delivery/twilio.ts";
import type { Env, Principal, QueuedSubscription, SubscriptionFilter } from "./types.ts";
import { registerDeviceRoutes } from "./devices.ts";

const PRICES = prices as unknown as PriceTable;
type Vars = { Bindings: Env; Variables: { principal: Principal } };
type App = Hono<Vars>;
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

const VERIFY_TTL_MS = 30 * 60_000;
const NEEDS_CODE: Transport[] = ["email", "sms", "voice"];
const CREATABLE: Transport[] = ["email", "sms", "voice", "webhook", "webpush", "apns", "fcm", "lxmf"];

interface EndpointRecord { id: string; account_id: string; kind: Transport; address: string; config: string; verify_code_hash: string | null; verify_attempts: number; verified_at: number | null; created_at: number }

export function validateAddress(kind: Transport, address: unknown): string {
  if (typeof address !== "string" || !address) throw new ApiError("bad_request", "address is required");
  const ok =
    kind === "email" ? EMAIL_RE.test(address) :
    kind === "sms" || kind === "voice" ? US_E164.test(address) :
    kind === "webhook" ? /^https:\/\/[^\s/]+(\/\S*)?$/.test(address) :
    kind === "webpush" ? (() => { try { const s = JSON.parse(address); return /^https:\/\//.test(s.endpoint) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string"; } catch { return false; } })() :
    kind === "apns" ? /^[0-9a-f]{64,200}$/i.test(address) :
    kind === "fcm" ? /^[\w:.-]{20,4096}$/.test(address) :
    kind === "lxmf" ? /^[0-9a-f]{32}$/i.test(address) :
    false;
  if (!ok) throw new ApiError("bad_request", kind === "sms" || kind === "voice" ? "only US numbers in E.164 form (+1NXXNXXXXXX) are supported for now" : `invalid ${kind} address`);
  return address;
}

const maskAddress = (kind: string, a: string) =>
  kind === "email" ? a.replace(/^(.).*(@.*)$/, "$1…$2") : kind === "sms" || kind === "voice" ? a.slice(0, 2) + "…" + a.slice(-4) : kind === "webpush" ? "(browser)" : a.length > 40 ? a.slice(0, 37) + "…" : a;

function publicEndpoint(e: EndpointRecord) {
  return { id: e.id, kind: e.kind, address: maskAddress(e.kind, e.address), verified: !!e.verified_at, created_at: e.created_at };
}

async function sendCode(env: Env, e: EndpointRecord, code: string) {
  // The verification message costs the same as a delivery and is charged before it is sent.
  const sku = skuForTransport(PRICES, e.kind)!;
  const price = actionPriceMicros(PRICES, sku);
  const r = await accountStub(env, e.account_id).charge(price, `verify:${e.id}:${ulid()}`, null, {});
  if (!r.ok) throw new ApiError("insufficient_balance", "balance can't cover the verification message", r.code === "insufficient_balance" ? { shortfall_usd_micros: r.shortfall } : {});
  const text = `Your SubEtha verification code is ${code}. If you didn't request this, ignore it.`;
  if (e.kind === "email") await sendEmail(env, { to: e.address, subject: `SubEtha verification code ${code}`, text });
  else if (e.kind === "sms") await sendSms(env, e.address, text);
  else await makeCall(env, e.address, voiceTwiml(`Your SubEtha verification code is ${code.split("").join(", ")}. Again: ${code.split("").join(", ")}.`, null));
}

/** Push the topic's current verified subscriptions into its Durable Object. */
export async function syncTopicSubscriptions(env: Env, topic: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.filter, s.after_s, s.min_priority, e.id AS endpoint_id, e.kind, e.address
     FROM subscriptions s JOIN endpoints e ON e.id = s.endpoint_id
     WHERE s.topic = ? AND e.verified_at IS NOT NULL`).bind(topic).all<{ id: string; filter: string; after_s: number; min_priority: number | null; endpoint_id: string; kind: Transport; address: string }>();
  const subs: QueuedSubscription[] = results.map((r) => ({
    id: r.id, transport: r.kind, endpoint: r.endpoint_id, address: r.kind === "webpush" ? undefined : r.address,
    filter: JSON.parse(r.filter) as SubscriptionFilter, after_s: r.after_s || undefined, min_priority: r.min_priority ?? undefined,
  }));
  await topicStub(env, topic).setSubscriptions(subs);
}

async function topicsForEndpoint(env: Env, endpointId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT DISTINCT topic FROM subscriptions WHERE endpoint_id = ?").bind(endpointId).all<{ topic: string }>();
  return results.map((r) => r.topic);
}

export function registerControlRoutes(app: App, principal: PrincipalFn) {
  registerDeviceRoutes(app, principal);
  // ---------------- endpoints ----------------
  app.get("/v1/endpoints", async (c) => {
    const id = requireAccount(await principal(c));
    const { results } = await c.env.DB.prepare("SELECT * FROM endpoints WHERE account_id = ? ORDER BY created_at DESC").bind(id).all<EndpointRecord>();
    return c.json({ endpoints: results.map(publicEndpoint) });
  });

  app.post("/v1/endpoints", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const body = (await c.req.json()) as { kind?: Transport; address?: string; name?: string };
    const kind = body.kind!;
    if (!CREATABLE.includes(kind)) throw new ApiError("bad_request", kind === "slack" ? "Slack endpoints are created by installing the Slack app (GET /v1/slack/install)" : `kind must be one of ${CREATABLE.join(", ")}`);
    const address = validateAddress(kind, body.address);
    if (kind === "webhook") {
      const host = new URL(address).hostname.toLowerCase();
      const own = new URL(c.env.BASE_URL).hostname.toLowerCase();
      if (host === own || host.endsWith(".subetha.org") || host === "subetha.org" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(host)) {
        throw new ApiError("bad_request", "webhooks can't target the relay itself or private addresses (use a topic subscription instead)");
      }
    }
    const now = Date.now();
    const id = `ep_${ulid()}`;
    const config: Record<string, unknown> = { name: body.name ?? "" };
    let secret: string | undefined;
    if (kind === "webhook") config.secret = secret = `whsec_${randomBase32(20)}`;
    const code = NEEDS_CODE.includes(kind) ? randomDigits(6) : null;
    const e: EndpointRecord = { id, account_id: accountId, kind, address, config: JSON.stringify(config), verify_code_hash: code ? await sha256Hex(`${id}:${code}`) : null, verify_attempts: 0, verified_at: code ? null : now, created_at: now };
    await c.env.DB.prepare("INSERT INTO endpoints (id, account_id, kind, address, config, verify_code_hash, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(e.id, e.account_id, e.kind, e.address, e.config, e.verify_code_hash, e.verified_at, e.created_at).run();
    if (code) {
      try {
        await sendCode(c.env, e, code);
      } catch (err) {
        await c.env.DB.prepare("DELETE FROM endpoints WHERE id = ?").bind(id).run();
        throw err instanceof ApiError ? err : new ApiError("provider_unavailable", (err as Error).message);
      }
    }
    await audit(c.env, accountId, p.kind, "endpoint.create", { id, kind });
    return c.json({ ...publicEndpoint(e), ...(secret ? { secret, note: "Verify X-SubEtha-Signature with this secret. Shown once." } : {}), ...(code ? { note: "A verification code was sent. POST /v1/endpoints/:id/verify {code}." } : {}) }, 201);
  });

  app.post("/v1/endpoints/:id/verify", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const e = await c.env.DB.prepare("SELECT * FROM endpoints WHERE id = ? AND account_id = ?").bind(c.req.param("id"), accountId).first<EndpointRecord>();
    if (!e) throw new ApiError("not_found");
    if (e.verified_at) return c.json(publicEndpoint(e));
    const { code } = (await c.req.json()) as { code?: string };
    if (e.verify_attempts >= 5 || Date.now() - e.created_at > VERIFY_TTL_MS) throw new ApiError("forbidden", "verification expired; delete the endpoint and add it again");
    await c.env.DB.prepare("UPDATE endpoints SET verify_attempts = verify_attempts + 1 WHERE id = ?").bind(e.id).run();
    if (!code || !e.verify_code_hash || !timingSafeEqual(await sha256Hex(`${e.id}:${code}`), e.verify_code_hash)) throw new ApiError("forbidden", "wrong code");
    await c.env.DB.prepare("UPDATE endpoints SET verified_at = ?, verify_code_hash = NULL WHERE id = ?").bind(Date.now(), e.id).run();
    for (const t of await topicsForEndpoint(c.env, e.id)) await syncTopicSubscriptions(c.env, t);
    return c.json({ ...publicEndpoint(e), verified: true });
  });

  app.delete("/v1/endpoints/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const id = c.req.param("id");
    const topics = await topicsForEndpoint(c.env, id);
    const r = await c.env.DB.prepare("DELETE FROM endpoints WHERE id = ? AND account_id = ?").bind(id, accountId).run();
    if (!r.meta.changes) throw new ApiError("not_found");
    await c.env.DB.prepare("DELETE FROM subscriptions WHERE endpoint_id = ?").bind(id).run();
    for (const t of topics) await syncTopicSubscriptions(c.env, t);
    await audit(c.env, accountId, p.kind, "endpoint.delete", { id });
    return c.json({ deleted: true });
  });

  // ---------------- subscriptions ----------------
  app.get("/v1/subscriptions", async (c) => {
    const accountId = requireAccount(await principal(c));
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.topic, s.endpoint_id, s.filter, s.after_s, s.min_priority, s.created_at, e.kind FROM subscriptions s
       JOIN endpoints e ON e.id = s.endpoint_id WHERE e.account_id = ? ORDER BY s.created_at DESC`).bind(accountId).all();
    return c.json({ subscriptions: results.map((r) => ({ ...r, filter: JSON.parse(r.filter as string) })) });
  });

  app.post("/v1/subscriptions", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const body = (await c.req.json()) as { topic?: string; endpoint_id?: string; filter?: SubscriptionFilter; after_s?: number; min_priority?: number };
    if (!body.topic || !isTopic(body.topic)) throw new ApiError("invalid_topic");
    const meta = await topicStub(c.env, body.topic).getMeta();
    if (!meta) throw new ApiError("not_found", "no such topic");
    if (meta.owner !== accountId) throw new ApiError("forbidden", "only the topic owner can add endpoint subscriptions (the owner pays for delivery)");
    const ep = await c.env.DB.prepare("SELECT id FROM endpoints WHERE id = ? AND account_id = ?").bind(body.endpoint_id ?? "", accountId).first();
    if (!ep) throw new ApiError("not_found", "no such endpoint");
    const after = body.after_s ?? 0;
    if (!Number.isInteger(after) || after < 0 || after > 3600) throw new ApiError("bad_request", "after_s must be 0..3600");
    if (body.min_priority !== undefined && !(Number.isInteger(body.min_priority) && body.min_priority >= 1 && body.min_priority <= 5)) throw new ApiError("bad_request", "min_priority must be 1..5");
    const id = `sub_${ulid()}`;
    await c.env.DB.prepare("INSERT INTO subscriptions (id, topic, endpoint_id, filter, after_s, min_priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, body.topic, body.endpoint_id, JSON.stringify(body.filter ?? {}), after, body.min_priority ?? null, Date.now()).run();
    await syncTopicSubscriptions(c.env, body.topic);
    await audit(c.env, accountId, p.kind, "subscription.create", { id, topic: body.topic });
    return c.json({ id, topic: body.topic, endpoint_id: body.endpoint_id, after_s: after, min_priority: body.min_priority ?? null }, 201);
  });

  app.delete("/v1/subscriptions/:id", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const row = await c.env.DB.prepare("SELECT s.topic FROM subscriptions s JOIN endpoints e ON e.id = s.endpoint_id WHERE s.id = ? AND e.account_id = ?").bind(c.req.param("id"), accountId).first<{ topic: string }>();
    if (!row) throw new ApiError("not_found");
    await c.env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(c.req.param("id")).run();
    await syncTopicSubscriptions(c.env, row.topic);
    return c.json({ deleted: true });
  });

  // ---------------- Twilio inbound ----------------
  const twilioParams = async (c: Context<Vars>) => {
    const form = await c.req.formData();
    const params: Record<string, string> = {};
    form.forEach((v, k) => { params[k] = String(v); });
    const url = `${c.env.BASE_URL}${new URL(c.req.url).pathname}${new URL(c.req.url).search}`;
    if (!c.env.TWILIO_AUTH_TOKEN || !(await verifyTwilioSignature(c.env.TWILIO_AUTH_TOKEN, url, params, c.req.header("x-twilio-signature") ?? null))) throw new ApiError("unauthorized", "bad Twilio signature");
    return params;
  };
  const twiml = (c: Context<Vars>, body = "<Response/>") => c.body(body, 200, { "content-type": "text/xml" });

  app.post("/v1/hooks/twilio/voice-ack", async (c) => {
    const params = await twilioParams(c);
    const topic = c.req.query("topic") ?? "", id = c.req.query("id") ?? "";
    if (!isTopic(topic) || c.req.query("t") !== (await ackToken(c.env.TWILIO_AUTH_TOKEN!, topic, id))) throw new ApiError("forbidden");
    if (params.Digits === "1") {
      await topicStub(c.env, topic).ack(id, "voice");
      return twiml(c, "<Response><Say>Acknowledged. Goodbye.</Say></Response>");
    }
    return twiml(c, "<Response><Say>Not acknowledged. Goodbye.</Say></Response>");
  });

  // Inbound SMS from a verified number publishes to the topic bound to that endpoint (config.inbound_topic).
  app.post("/v1/hooks/twilio/sms", async (c) => {
    const params = await twilioParams(c);
    const from = params.From ?? "", body = (params.Body ?? "").trim();
    if (/^(help|info)$/i.test(body)) {
      return twiml(c, "<Response><Message>SubEtha notifications. Manage at subetha.org/console. Reply STOP to opt out. Msg &amp; data rates may apply.</Message></Response>");
    }
    const ep = await c.env.DB.prepare("SELECT * FROM endpoints WHERE kind = 'sms' AND address = ? AND verified_at IS NOT NULL ORDER BY created_at LIMIT 1").bind(from).first<EndpointRecord>();
    if (!ep) return twiml(c);
    if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body)) {
      await c.env.DB.prepare("UPDATE endpoints SET verified_at = NULL WHERE kind IN ('sms','voice') AND address = ?").bind(from).run();
      for (const t of await topicsForEndpoint(c.env, ep.id)) await syncTopicSubscriptions(c.env, t);
      return twiml(c);
    }
    const ackMatch = /^ack\s+([0-9a-z]{26})$/i.exec(body);
    const cfg = JSON.parse(ep.config) as { inbound_topic?: string };
    if (ackMatch) {
      for (const t of await topicsForEndpoint(c.env, ep.id)) await topicStub(c.env, t).ack(ackMatch[1]!, "sms");
      return twiml(c);
    }
    if (!cfg.inbound_topic) return twiml(c);
    const price = actionPriceMicros(PRICES, "inbound_sms_us");
    const charge = await accountStub(c.env, ep.account_id).charge(price, `insms:${params.MessageSid}`, null, {});
    if (!charge.ok) return twiml(c);
    unwrap(await topicStub(c.env, cfg.inbound_topic).publish({
      envelope: { topic: cfg.inbound_topic, message: body.slice(0, 4096), tags: ["sms"], sms_from: maskAddress("sms", from) } as never,
      caller: { accountId: ep.account_id, tokenId: null, deviceId: null, caps: { daily: null, total: null }, transports: null },
      autoCreateOwner: null, idempotencyKey: `sms:${params.MessageSid}`, bodyHash: params.MessageSid ?? "", dryRun: false,
      route: { mode: "any", maxCost: null, deny: ["sms"], allow: null },
    }));
    return twiml(c);
  });

  // ---------------- Slack ----------------
  app.get("/v1/slack/install", async (c) => {
    const accountId = requireAdmin(await principal(c));
    if (!c.env.SLACK_CLIENT_ID) throw new ApiError("provider_unavailable", "Slack app not configured");
    const state = `${accountId}.${randomBase32(10)}`;
    await c.env.CACHE.put(`slack_state:${state}`, accountId, { expirationTtl: 600 });
    const u = new URL("https://slack.com/oauth/v2/authorize");
    u.searchParams.set("client_id", c.env.SLACK_CLIENT_ID);
    u.searchParams.set("scope", "chat:write,channels:history,groups:history,channels:read");
    u.searchParams.set("redirect_uri", `${c.env.BASE_URL}/v1/slack/oauth`);
    u.searchParams.set("state", state);
    return c.json({ url: u.toString() });
  });

  app.get("/v1/slack/oauth", async (c) => {
    const state = c.req.query("state") ?? "";
    const accountId = await c.env.CACHE.get(`slack_state:${state}`);
    if (!accountId) throw new ApiError("forbidden", "invalid or expired state");
    await c.env.CACHE.delete(`slack_state:${state}`);
    const r = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: c.req.query("code") ?? "", client_id: c.env.SLACK_CLIENT_ID ?? "", client_secret: c.env.SLACK_CLIENT_SECRET ?? "", redirect_uri: `${c.env.BASE_URL}/v1/slack/oauth` }).toString(),
    });
    const j = (await r.json()) as { ok: boolean; access_token?: string; team?: { id: string; name: string }; incoming_webhook?: unknown; error?: string };
    if (!j.ok || !j.access_token || !j.team) throw new ApiError("provider_unavailable", `Slack: ${j.error ?? "install failed"}`);
    await c.env.DB.prepare("INSERT INTO slack_teams (team_id, account_id, team_name, bot_token, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, account_id) DO UPDATE SET bot_token = excluded.bot_token, team_name = excluded.team_name")
      .bind(j.team.id, accountId, j.team.name, j.access_token, Date.now()).run();
    return c.redirect(`/console/#slack=installed&team=${encodeURIComponent(j.team.name)}`, 302);
  });

  /** Bind a Slack channel to a topic: messages flow both ways (topic → channel via an endpoint; channel → topic via Events). */
  app.post("/v1/slack/bindings", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const body = (await c.req.json()) as { team_id?: string; channel?: string; topic?: string; inbound?: boolean; outbound?: boolean };
    if (!body.topic || !isTopic(body.topic) || !body.channel || !/^[CG][A-Z0-9]{6,}$/.test(body.channel)) throw new ApiError("bad_request", "team_id, channel (C…), and topic are required");
    const team = await c.env.DB.prepare("SELECT bot_token FROM slack_teams WHERE team_id = ? AND account_id = ?").bind(body.team_id ?? "", accountId).first<{ bot_token: string }>();
    if (!team) throw new ApiError("not_found", "install the Slack app for this team first");
    const meta = await topicStub(c.env, body.topic).getMeta();
    if (!meta || meta.owner !== accountId) throw new ApiError("forbidden", "you must own the topic");
    let endpointId: string | null = null;
    if (body.outbound !== false) {
      endpointId = `ep_${ulid()}`;
      await c.env.DB.prepare("INSERT INTO endpoints (id, account_id, kind, address, config, verified_at, created_at) VALUES (?, ?, 'slack', ?, ?, ?, ?)")
        .bind(endpointId, accountId, body.channel, JSON.stringify({ bot_token: team.bot_token, team_id: body.team_id }), Date.now(), Date.now()).run();
      await c.env.DB.prepare("INSERT INTO subscriptions (id, topic, endpoint_id, filter, after_s, created_at) VALUES (?, ?, ?, '{}', 0, ?)").bind(`sub_${ulid()}`, body.topic, endpointId, Date.now()).run();
      await syncTopicSubscriptions(c.env, body.topic);
    }
    if (body.inbound !== false) {
      await c.env.DB.prepare("INSERT OR REPLACE INTO slack_bindings (team_id, channel, topic, account_id, endpoint_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(body.team_id, body.channel, body.topic, accountId, endpointId, Date.now()).run();
    }
    return c.json({ bound: true, endpoint_id: endpointId }, 201);
  });

  app.post("/v1/hooks/slack/events", async (c) => {
    const raw = await c.req.text();
    if (!c.env.SLACK_SIGNING_SECRET || !(await verifySlackSignature(c.env.SLACK_SIGNING_SECRET, raw, c.req.header("x-slack-request-timestamp") ?? null, c.req.header("x-slack-signature") ?? null))) throw new ApiError("unauthorized", "bad Slack signature");
    const evt = JSON.parse(raw) as { type: string; challenge?: string; team_id?: string; event_id?: string; event?: { type: string; subtype?: string; bot_id?: string; channel?: string; text?: string; user?: string } };
    if (evt.type === "url_verification") return c.json({ challenge: evt.challenge });
    const e = evt.event;
    if (evt.type !== "event_callback" || !e || e.type !== "message" || e.subtype || e.bot_id || !e.text) return c.json({ ok: true });
    const binding = await c.env.DB.prepare("SELECT topic, account_id FROM slack_bindings WHERE team_id = ? AND channel = ?").bind(evt.team_id ?? "", e.channel ?? "").first<{ topic: string; account_id: string }>();
    if (!binding) return c.json({ ok: true });
    c.executionCtx.waitUntil((async () => {
      const r = await topicStub(c.env, binding.topic).publish({
        envelope: { topic: binding.topic, message: e.text!.slice(0, 4096), tags: ["slack"], slack_user: e.user } as never,
        caller: { accountId: binding.account_id, tokenId: null, deviceId: null, caps: { daily: null, total: null }, transports: null },
        autoCreateOwner: null, idempotencyKey: `slack:${evt.event_id}`, bodyHash: evt.event_id ?? "", dryRun: false,
        // Don't echo the message back into the channel it came from.
        route: { mode: "any", maxCost: null, deny: ["slack"], allow: null },
      });
      if (!r.ok) console.warn("slack inbound publish failed", r.error);
    })());
    return c.json({ ok: true });
  });
}
