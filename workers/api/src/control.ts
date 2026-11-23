// Control plane for endpoints (verified destinations), subscriptions (topic → endpoint), and
// inbound provider hooks (Twilio, Slack). PLAN §6, §9, §11.
import type { Context, Hono } from "hono";
import { isTopic, ulid, type Transport } from "@subetha/sdk/protocol";
import { actionPriceMicros, skuForTransport, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { accountTier, audit } from "./accounts.ts";
import { discardAttachment, recordAttachment, storeAttachment } from "./attachments.ts";
import { requireAdmin } from "./auth.ts";
import { randomBase32, randomDigits, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { accountStub } from "./durable/account.ts";
import { topicStub } from "./durable/topic.ts";
import { ApiError, unwrap } from "./errors.ts";
import { EMAIL_RE, sendEmail } from "./delivery/email.ts";
import { verifySlackSignature } from "./delivery/slack.ts";
import { ackToken, fetchInboundMedia, makeCall, sendSms, verifyTwilioSignature, voiceMinutes, voiceTwiml } from "./delivery/twilio.ts";
import { DEST_PRICES_KEY, destUnitPrice, INTL_COUNTRIES, phoneCountry, type DestinationPrices } from "./delivery/destinations.ts";
import type { Env, Principal, QueuedSubscription, SubscriptionFilter } from "./types.ts";
import { registerDeviceRoutes } from "./devices.ts";
import { registerInspectorRoutes } from "./inspector.ts";
import { registerPushCredentialRoutes } from "./push-credentials.ts";
import { checkTelephonyCircuit } from "./cron.ts";
import { emitMetric, estimatedCostMicros } from "./telemetry.ts";

const PRICES = prices as unknown as PriceTable;
type Vars = { Bindings: Env; Variables: { principal: Principal } };
type App = Hono<Vars>;
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

const VERIFY_TTL_MS = 30 * 60_000;
const MAX_PENDING_VERIFICATIONS = 5;
const NEEDS_CODE: Transport[] = ["email", "sms", "voice"];
const CREATABLE: Transport[] = ["email", "sms", "voice", "webhook", "webpush", "apns", "fcm", "lxmf"];

interface EndpointRecord { id: string; account_id: string; kind: Transport; address: string; config: string; verify_code_hash: string | null; verify_attempts: number; verified_at: number | null; created_at: number }

/** Webhooks must name a public host by DNS name, never the relay itself or an IP literal. */
export function assertPublicWebhook(address: string, baseUrl: string) {
  const host = new URL(address).hostname.toLowerCase().replace(/\.+$/, "");
  const own = new URL(baseUrl).hostname.toLowerCase();
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
  if (ipLiteral || host === own || host === "subetha.us" || host.endsWith(".subetha.us") || host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new ApiError("bad_request", "webhooks must use a public DNS name (no IP literals, localhost, or the relay itself)");
  }
}

export function validateAddress(kind: Transport, address: unknown): string {
  if (typeof address !== "string" || !address) throw new ApiError("bad_request", "address is required");
  const ok =
    kind === "email" ? EMAIL_RE.test(address) :
    kind === "sms" || kind === "voice" ? phoneCountry(address) !== null :
    kind === "webhook" ? /^https:\/\/[^\s/]+(\/\S*)?$/.test(address) :
    kind === "webpush" ? (() => { try { const s = JSON.parse(address); return /^https:\/\//.test(s.endpoint) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string"; } catch { return false; } })() :
    kind === "apns" ? /^[0-9a-f]{64,200}$/i.test(address) :
    kind === "fcm" ? /^[\w:.-]{20,4096}$/.test(address) :
    kind === "lxmf" ? /^[0-9a-f]{32}$/i.test(address) :
    false;
  if (!ok) throw new ApiError("bad_request", kind === "sms" || kind === "voice" ? `unsupported phone number: use E.164 (+…) for the US or one of ${Object.keys(INTL_COUNTRIES).join(", ")}; premium-rate and non-geographic numbers are not served` : `invalid ${kind} address`);
  return address;
}

const maskAddress = (kind: string, a: string) =>
  kind === "email" ? a.replace(/^(.).*(@.*)$/, "$1…$2") : kind === "sms" || kind === "voice" ? a.slice(0, 2) + "…" + a.slice(-4) : kind === "webpush" ? "(browser)" : a.length > 40 ? a.slice(0, 37) + "…" : a;

function publicEndpoint(e: EndpointRecord) {
  const cfg = JSON.parse(e.config || "{}") as { name?: string; inbound_topic?: string; credential_id?: string };
  return {
    id: e.id, kind: e.kind, address: maskAddress(e.kind, e.address), verified: !!e.verified_at, created_at: e.created_at,
    ...(cfg.name ? { name: cfg.name } : {}),
    ...(cfg.inbound_topic ? { inbound_topic: cfg.inbound_topic } : {}),
    ...(cfg.credential_id ? { credential_id: cfg.credential_id } : {}),
  };
}

export async function loadDestPrices(env: Env): Promise<DestinationPrices | null> {
  return env.CACHE.get<DestinationPrices>(DEST_PRICES_KEY, "json");
}

/** Accounts' opt-in countries outside the US (PLAN §8). */
export const optedCountries = (json: string | null | undefined): string[] => (json ? (JSON.parse(json) as string[]) : []);

/**
 * Price (µ$, standard tier) of one SMS segment or call minute to `address`, after checking that the
 * destination is served: US numbers use the static SKU; other countries must be opted into by the
 * account and have a current live price.
 */
export async function telephonyUnitPrice(env: Env, accountId: string, kind: "sms" | "voice", address: string): Promise<number> {
  const country = phoneCountry(address);
  if (!country) throw new ApiError("bad_request", "unsupported phone number");
  const tier = await accountTier(env, accountId);
  if (country === "US") return actionPriceMicros(PRICES, skuForTransport(PRICES, kind)!, tier);
  const row = await env.DB.prepare("SELECT telephony_countries FROM accounts WHERE id = ?").bind(accountId).first<{ telephony_countries: string | null }>();
  if (!optedCountries(row?.telephony_countries).includes(country)) {
    throw new ApiError("forbidden", `${INTL_COUNTRIES[country]!.name} (${country}) isn't enabled for this account; add it to telephony_countries with PATCH /v1/account`);
  }
  const p = destUnitPrice(await loadDestPrices(env), kind, country, tier);
  if (p === null) throw new ApiError("provider_unavailable", `no current ${kind} price for ${country}; try again later`);
  return p;
}

const VERIFY_SEND_INTERVAL_MS = 3_600_000;

/**
 * Claims this hour's verification send for a destination. One conditional upsert, so concurrent
 * requests (from any account) can't both win. Returns the claim's timestamp, or null if a code
 * went to the destination within the hour.
 */
export async function claimVerifySend(env: Env, dest: string, now = Date.now()): Promise<number | null> {
  const r = await env.DB.prepare(
    "INSERT INTO verify_sends (dest, sent_at) VALUES (?, ?) ON CONFLICT(dest) DO UPDATE SET sent_at = excluded.sent_at WHERE verify_sends.sent_at <= ?",
  ).bind(dest, now, now - VERIFY_SEND_INTERVAL_MS).run();
  return r.meta.changes === 1 ? now : null;
}

/** Gives a claim back when nothing was sent (the account couldn't pay). */
async function releaseVerifySend(env: Env, dest: string, sentAt: number) {
  await env.DB.prepare("DELETE FROM verify_sends WHERE dest = ? AND sent_at = ?").bind(dest, sentAt).run();
}

async function sendCode(env: Env, e: EndpointRecord, code: string) {
  const telephony = e.kind === "sms" || e.kind === "voice";
  // One code per destination per hour, and a few pending verifications per account per day:
  // verification sends go to unverified numbers/addresses, so they're the abuse surface.
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM endpoints WHERE account_id = ? AND verified_at IS NULL AND created_at > ?").bind(e.account_id, Date.now() - 86_400_000).first<{ n: number }>();
  if ((pending?.n ?? 0) > MAX_PENDING_VERIFICATIONS) throw new ApiError("rate_limited", "too many unverified endpoints in the last day");
  if (telephony && (await checkTelephonyCircuit(env, e.account_id))) throw new ApiError("provider_unavailable", "SMS and voice are temporarily paused");
  const dest = `${e.kind}:${e.address.toLowerCase()}`;
  const sentAt = await claimVerifySend(env, dest);
  if (sentAt === null) throw new ApiError("rate_limited", "a code was sent to this destination recently; try again in an hour");
  // The verification message costs the same as a delivery and is paid before it is sent; SMS and
  // calls count toward the new-funds telephony hold.
  const price = e.kind === "sms" || e.kind === "voice"
    ? await telephonyUnitPrice(env, e.account_id, e.kind, e.address)
    : actionPriceMicros(PRICES, skuForTransport(PRICES, e.kind)!, await accountTier(env, e.account_id));
  const ref = `verify:${e.id}:${ulid()}`;
  const account = accountStub(env, e.account_id);
  const r = await account.reserve(price, ref, null, {}, telephony ? "telephony" : null);
  if (!r.ok) {
    await releaseVerifySend(env, dest, sentAt);
    throw r.code === "insufficient_balance"
      ? new ApiError("insufficient_balance", "balance can't cover the verification message", { shortfall_usd_micros: r.shortfall })
      : new ApiError("spend_cap_exceeded", "SMS/voice spend is limited for new funds; try again later or use email");
  }
  await account.settle(ref, price);
  const text = `Your SubEtha verification code is ${code}. If you didn't request this, ignore it.`;
  if (e.kind === "email") await sendEmail(env, { to: e.address, subject: `SubEtha verification code ${code}`, text });
  else if (e.kind === "sms") await sendSms(env, e.address, text);
  else await makeCall(env, e.address, voiceTwiml(`Your SubEtha verification code is ${code.split("").join(", ")}. Again: ${code.split("").join(", ")}.`, null));
}

/** Push the topic's current verified subscriptions into its Durable Object. */
export async function syncTopicSubscriptions(env: Env, topic: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.filter, s.after_s, s.min_priority, e.id AS endpoint_id, e.kind, e.address, a.telephony_countries
     FROM subscriptions s JOIN endpoints e ON e.id = s.endpoint_id JOIN accounts a ON a.id = e.account_id
     WHERE s.topic = ? AND s.paused = 0 AND e.verified_at IS NOT NULL AND a.frozen_since IS NULL`).bind(topic).all<{ id: string; filter: string; after_s: number; min_priority: number | null; endpoint_id: string; kind: Transport; address: string; telephony_countries: string | null }>();
  const subs: QueuedSubscription[] = [];
  for (const r of results) {
    // Numbers outside the US deliver only while the owner keeps their country enabled.
    const country = r.kind === "sms" || r.kind === "voice" ? phoneCountry(r.address) : null;
    if ((r.kind === "sms" || r.kind === "voice") && (!country || (country !== "US" && !optedCountries(r.telephony_countries).includes(country)))) continue;
    subs.push({
      id: r.id, transport: r.kind, endpoint: r.endpoint_id, address: r.kind === "webpush" ? undefined : r.address,
      filter: JSON.parse(r.filter) as SubscriptionFilter, after_s: r.after_s || undefined, min_priority: r.min_priority ?? undefined,
      ...(country && country !== "US" ? { country } : {}),
    });
  }
  await topicStub(env, topic).setSubscriptions(subs);
}

/** Re-plans every topic that delivers to one of `accountId`'s endpoints (after a freeze/unfreeze). */
export async function syncAccountEndpoints(env: Env, accountId: string) {
  const { results } = await env.DB.prepare("SELECT DISTINCT s.topic FROM subscriptions s JOIN endpoints e ON e.id = s.endpoint_id WHERE e.account_id = ?").bind(accountId).all<{ topic: string }>();
  for (const r of results) await syncTopicSubscriptions(env, r.topic);
}

async function topicsForEndpoint(env: Env, endpointId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT DISTINCT topic FROM subscriptions WHERE endpoint_id = ?").bind(endpointId).all<{ topic: string }>();
  return results.map((r) => r.topic);
}

export function registerControlRoutes(app: App, principal: PrincipalFn) {
  registerDeviceRoutes(app, principal);
  registerInspectorRoutes(app, principal);
  registerPushCredentialRoutes(app, principal);
  // ---------------- endpoints ----------------
  app.get("/v1/endpoints", async (c) => {
    const id = requireAdmin(await principal(c));
    const { results } = await c.env.DB.prepare("SELECT * FROM endpoints WHERE account_id = ? ORDER BY created_at DESC").bind(id).all<EndpointRecord>();
    return c.json({ endpoints: results.map(publicEndpoint) });
  });

  app.post("/v1/endpoints", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const body = (await c.req.json()) as { kind?: Transport; address?: string; name?: string; credential_id?: string };
    const kind = body.kind!;
    if (!CREATABLE.includes(kind)) throw new ApiError("bad_request", kind === "slack" ? "Slack endpoints are created by installing the Slack app (GET /v1/slack/install)" : `kind must be one of ${CREATABLE.join(", ")}`);
    const address = validateAddress(kind, body.address);
    if (kind === "sms" || kind === "voice") await telephonyUnitPrice(c.env, accountId, kind, address);
    if (kind === "webhook") assertPublicWebhook(address, c.env.BASE_URL);
    // Web Push endpoints are URLs we POST to as well (the browser's push service).
    if (kind === "webpush") assertPublicWebhook(JSON.parse(address).endpoint, c.env.BASE_URL);
    const now = Date.now();
    const id = `ep_${ulid()}`;
    const config: Record<string, unknown> = { name: body.name ?? "" };
    if (body.credential_id !== undefined) {
      if (kind !== "apns" && kind !== "fcm") throw new ApiError("bad_request", "credential_id applies to apns and fcm endpoints only");
      if (typeof body.credential_id !== "string" || !body.credential_id) throw new ApiError("bad_request", "invalid credential_id");
      const cred = await c.env.DB.prepare("SELECT id FROM push_credentials WHERE id = ? AND account_id = ? AND kind = ?").bind(body.credential_id, accountId, kind).first();
      if (!cred) throw new ApiError("not_found", `no such ${kind} push credential`);
      config.credential_id = body.credential_id;
    }
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
    const expired = () => new ApiError("forbidden", "verification expired; delete the endpoint and add it again");
    if (Date.now() - e.created_at > VERIFY_TTL_MS) throw expired();
    // Count the attempt atomically, so parallel guesses can't get past the limit of 5.
    const counted = await c.env.DB.prepare("UPDATE endpoints SET verify_attempts = verify_attempts + 1 WHERE id = ? AND verify_attempts < 5").bind(e.id).run();
    if (!counted.meta.changes) throw expired();
    if (!code || !e.verify_code_hash || !timingSafeEqual(await sha256Hex(`${e.id}:${code}`), e.verify_code_hash)) throw new ApiError("forbidden", "wrong code");
    await c.env.DB.prepare("UPDATE endpoints SET verified_at = ?, verify_code_hash = NULL WHERE id = ?").bind(Date.now(), e.id).run();
    for (const t of await topicsForEndpoint(c.env, e.id)) await syncTopicSubscriptions(c.env, t);
    return c.json({ ...publicEndpoint(e), verified: true });
  });

  // Rename an endpoint, or (SMS) choose the topic that texts from its number publish to.
  app.patch("/v1/endpoints/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const e = await c.env.DB.prepare("SELECT * FROM endpoints WHERE id = ? AND account_id = ?").bind(c.req.param("id"), accountId).first<EndpointRecord>();
    if (!e) throw new ApiError("not_found");
    const body = (await c.req.json()) as { name?: unknown; inbound_topic?: unknown; credential_id?: unknown };
    const cfg = JSON.parse(e.config || "{}") as Record<string, unknown>;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.length > 100) throw new ApiError("bad_request", "name must be a string of up to 100 characters");
      cfg.name = body.name;
    }
    if (body.inbound_topic !== undefined) {
      if (e.kind !== "sms") throw new ApiError("bad_request", "inbound_topic applies to sms endpoints only");
      if (body.inbound_topic === null) delete cfg.inbound_topic;
      else {
        if (typeof body.inbound_topic !== "string" || !isTopic(body.inbound_topic)) throw new ApiError("invalid_topic");
        const meta = await topicStub(c.env, body.inbound_topic).getMeta();
        if (!meta || meta.owner !== accountId) throw new ApiError("forbidden", "inbound_topic must be a topic you own");
        cfg.inbound_topic = body.inbound_topic;
      }
    }
    if (body.credential_id !== undefined) {
      if (e.kind !== "apns" && e.kind !== "fcm") throw new ApiError("bad_request", "credential_id applies to apns and fcm endpoints only");
      if (body.credential_id === null) delete cfg.credential_id;
      else {
        if (typeof body.credential_id !== "string" || !body.credential_id) throw new ApiError("bad_request", "invalid credential_id");
        const cred = await c.env.DB.prepare("SELECT id FROM push_credentials WHERE id = ? AND account_id = ? AND kind = ?").bind(body.credential_id, accountId, e.kind).first();
        if (!cred) throw new ApiError("not_found", `no such ${e.kind} push credential`);
        cfg.credential_id = body.credential_id;
      }
    }
    e.config = JSON.stringify(cfg);
    await c.env.DB.prepare("UPDATE endpoints SET config = ? WHERE id = ?").bind(e.config, e.id).run();
    await audit(c.env, accountId, p.kind, "endpoint.update", { id: e.id, ...(body.inbound_topic !== undefined ? { inbound_topic: cfg.inbound_topic ?? null } : {}) });
    return c.json(publicEndpoint(e));
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
  const validateSubFilter = (f: unknown): SubscriptionFilter => {
    if (f === undefined) return {};
    if (typeof f !== "object" || f === null || Array.isArray(f)) throw new ApiError("bad_request", "filter must be an object");
    const obj = f as { priority?: unknown; tags?: unknown };
    const out: SubscriptionFilter = {};
    if (obj.priority !== undefined) {
      if (!Array.isArray(obj.priority) || !obj.priority.every((n) => Number.isInteger(n) && n >= 1 && n <= 5)) throw new ApiError("bad_request", "filter.priority must be an array of integers 1..5");
      if (obj.priority.length) out.priority = obj.priority;
    }
    if (obj.tags !== undefined) {
      if (!Array.isArray(obj.tags) || obj.tags.length > 32 || !obj.tags.every((t) => typeof t === "string" && t.length > 0 && t.length <= 64)) throw new ApiError("bad_request", "filter.tags must be an array of up to 32 strings");
      if (obj.tags.length) out.tags = obj.tags;
    }
    return out;
  };

  app.get("/v1/subscriptions", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.topic, s.endpoint_id, s.filter, s.after_s, s.min_priority, s.paused, s.created_at, e.kind FROM subscriptions s
       JOIN endpoints e ON e.id = s.endpoint_id WHERE e.account_id = ? ORDER BY s.created_at DESC`).bind(accountId).all();
    return c.json({ subscriptions: results.map((r) => ({ ...r, filter: JSON.parse(r.filter as string), paused: !!r.paused })) });
  });

  app.post("/v1/subscriptions", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const body = (await c.req.json()) as { topic?: string; endpoint_id?: string; filter?: SubscriptionFilter; after_s?: number; min_priority?: number; paused?: boolean };
    if (!body.topic || !isTopic(body.topic)) throw new ApiError("invalid_topic");
    const meta = await topicStub(c.env, body.topic).getMeta();
    if (!meta) throw new ApiError("not_found", "no such topic");
    if (meta.owner !== accountId) throw new ApiError("forbidden", "only the topic owner can add endpoint subscriptions (the owner pays for delivery)");
    const ep = await c.env.DB.prepare("SELECT id FROM endpoints WHERE id = ? AND account_id = ?").bind(body.endpoint_id ?? "", accountId).first();
    if (!ep) throw new ApiError("not_found", "no such endpoint");
    const after = body.after_s ?? 0;
    if (!Number.isInteger(after) || after < 0 || after > 3600) throw new ApiError("bad_request", "after_s must be 0..3600");
    if (body.min_priority !== undefined && !(Number.isInteger(body.min_priority) && body.min_priority >= 1 && body.min_priority <= 5)) throw new ApiError("bad_request", "min_priority must be 1..5");
    if (body.paused !== undefined && typeof body.paused !== "boolean") throw new ApiError("bad_request", "paused must be a boolean");
    const filter = validateSubFilter(body.filter);
    const paused = !!body.paused;
    const id = `sub_${ulid()}`;
    await c.env.DB.prepare("INSERT INTO subscriptions (id, topic, endpoint_id, filter, after_s, min_priority, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, body.topic, body.endpoint_id, JSON.stringify(filter), after, body.min_priority ?? null, paused ? 1 : 0, Date.now()).run();
    await syncTopicSubscriptions(c.env, body.topic);
    await audit(c.env, accountId, p.kind, "subscription.create", { id, topic: body.topic });
    return c.json({ id, topic: body.topic, endpoint_id: body.endpoint_id, filter, after_s: after, min_priority: body.min_priority ?? null, paused }, 201);
  });

  app.patch("/v1/subscriptions/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const id = c.req.param("id");
    const row = await c.env.DB.prepare(
      `SELECT s.id, s.topic, s.endpoint_id, s.filter, s.after_s, s.min_priority, s.paused, s.created_at, e.kind
         FROM subscriptions s JOIN endpoints e ON e.id = s.endpoint_id
        WHERE s.id = ? AND e.account_id = ?`,
    ).bind(id, accountId).first<{ id: string; topic: string; endpoint_id: string; filter: string; after_s: number; min_priority: number | null; paused: number; created_at: number; kind: Transport }>();
    if (!row) throw new ApiError("not_found");
    const body = (await c.req.json()) as { filter?: unknown; after_s?: unknown; min_priority?: unknown; paused?: unknown };
    let filter = JSON.parse(row.filter) as SubscriptionFilter;
    let after = row.after_s;
    let minPriority = row.min_priority;
    let paused = !!row.paused;
    if (body.filter !== undefined) filter = validateSubFilter(body.filter);
    if (body.after_s !== undefined) {
      if (typeof body.after_s !== "number" || !Number.isInteger(body.after_s) || body.after_s < 0 || body.after_s > 3600) {
        throw new ApiError("bad_request", "after_s must be 0..3600");
      }
      after = body.after_s;
    }
    if (body.min_priority !== undefined) {
      if (body.min_priority === null) minPriority = null;
      else if (typeof body.min_priority === "number" && Number.isInteger(body.min_priority) && body.min_priority >= 1 && body.min_priority <= 5) minPriority = body.min_priority;
      else throw new ApiError("bad_request", "min_priority must be 1..5 or null");
    }
    if (body.paused !== undefined) {
      if (typeof body.paused !== "boolean") throw new ApiError("bad_request", "paused must be a boolean");
      paused = body.paused;
    }
    await c.env.DB.prepare("UPDATE subscriptions SET filter = ?, after_s = ?, min_priority = ?, paused = ? WHERE id = ?")
      .bind(JSON.stringify(filter), after, minPriority, paused ? 1 : 0, id).run();
    await syncTopicSubscriptions(c.env, row.topic);
    await audit(c.env, accountId, p.kind, "subscription.update", { id, topic: row.topic, after_s: after, min_priority: minPriority, paused });
    return c.json({ id: row.id, topic: row.topic, endpoint_id: row.endpoint_id, kind: row.kind, filter, after_s: after, min_priority: minPriority, paused, created_at: row.created_at });
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

  // Call finished: settle the reservation to the billed minutes (never more than reserved).
  app.post("/v1/hooks/twilio/voice-status", async (c) => {
    const params = await twilioParams(c);
    const acct = c.req.query("acct") ?? "", ref = c.req.query("ref") ?? "", max = Number(c.req.query("max") ?? 0);
    if (c.req.query("t") !== (await ackToken(c.env.TWILIO_AUTH_TOKEN!, acct, `${ref}:${max}`))) throw new ApiError("forbidden");
    const minutes = Math.ceil(Number(params.CallDuration ?? 0) / 60);
    const perMinute = Math.floor(max / voiceMinutes(""));
    await accountStub(c.env, acct).settle(ref, Math.min(max, minutes * perMinute));
    return twiml(c);
  });

  // Inbound SMS from a verified number publishes to the topic bound to that endpoint (config.inbound_topic).
  app.post("/v1/hooks/twilio/sms", async (c) => {
    const params = await twilioParams(c);
    const from = params.From ?? "", body = (params.Body ?? "").trim();
    if (/^(help|info)$/i.test(body)) {
      return twiml(c, "<Response><Message>SubEtha notifications. Manage at subetha.us/console. Reply STOP to opt out. Msg &amp; data rates may apply.</Message></Response>");
    }
    // The same number can be verified on several accounts; the oldest one with an inbound topic wins.
    const ep = await c.env.DB.prepare("SELECT * FROM endpoints WHERE kind = 'sms' AND address = ? AND verified_at IS NOT NULL ORDER BY json_extract(config, '$.inbound_topic') IS NULL, created_at LIMIT 1").bind(from).first<EndpointRecord>();
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
    // An MMS's first picture becomes the message's attachment (billed as inbound_mms_us, plus
    // the attachment's upload and storage like any publish); other media types are dropped.
    const media = Number(params.NumMedia ?? 0) > 0 && c.env.FILES ? await fetchInboundMedia(c.env, params.MediaUrl0 ?? "").catch(() => null) : null;
    const sku = media ? "inbound_mms_us" : "inbound_sms_us";
    const price = actionPriceMicros(PRICES, sku, await accountTier(c.env, ep.account_id));
    const charge = await accountStub(c.env, ep.account_id).charge(price, `insms:${params.MessageSid}`, null, {}, true);
    if (!charge.ok) return twiml(c);
    emitMetric(c.env, { accountId: ep.account_id, event: "inbound_sms", transport: "sms", sku, revenueMicros: price, providerCostMicros: estimatedCostMicros(sku) });
    const stored = media ? await storeAttachment(c.env, media) : null;
    const envelope = { topic: cfg.inbound_topic, message: (body || (media ? `You received a file: ${media.name}` : "")).slice(0, 4096), tags: ["sms"], sms_from: maskAddress("sms", from), ...(stored ? { attachment: stored.attachment } : {}) };
    let result;
    try {
      result = unwrap(await topicStub(c.env, cfg.inbound_topic).publish({
        envelope: envelope as never,
        caller: { accountId: ep.account_id, tokenId: null, deviceId: null, caps: { daily: null, total: null }, transports: null },
        autoCreateOwner: null, idempotencyKey: `sms:${params.MessageSid}`, bodyHash: params.MessageSid ?? "", dryRun: false,
        attachmentBytes: media?.bytes.length,
        route: { mode: "any", maxCost: null, deny: ["sms"], allow: null },
      }));
    } catch (e) {
      if (stored) await discardAttachment(c.env, stored.fileId);
      throw e;
    }
    if (stored) await recordAttachment(c.env, stored.fileId, media!, cfg.inbound_topic, result);
    return twiml(c);
  });

  // ---------------- Slack ----------------
  app.get("/v1/slack/install", async (c) => {
    const accountId = requireAdmin(await principal(c));
    if (!c.env.SLACK_CLIENT_ID) throw new ApiError("provider_unavailable", "Slack app not configured");
    const state = `${accountId}.${randomBase32(10)}`;
    await c.env.CACHE.put(`slack_state:${state}`, accountId, { expirationTtl: 600 });
    // Bind the OAuth state to this browser, so an install link can't be replayed by someone else.
    c.header("set-cookie", `slack_state=${state}; Path=/v1/slack/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
    const u = new URL("https://slack.com/oauth/v2/authorize");
    u.searchParams.set("client_id", c.env.SLACK_CLIENT_ID);
    u.searchParams.set("scope", "chat:write,channels:history,groups:history,channels:read");
    u.searchParams.set("redirect_uri", `${c.env.BASE_URL}/v1/slack/oauth`);
    u.searchParams.set("state", state);
    return c.json({ url: u.toString() });
  });

  app.get("/v1/slack/oauth", async (c) => {
    const state = c.req.query("state") ?? "";
    const cookie = /(?:^|;\s*)slack_state=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
    const accountId = await c.env.CACHE.get(`slack_state:${state}`);
    if (!accountId || cookie !== state) throw new ApiError("forbidden", "invalid or expired state; start the install from the console");
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
    return c.redirect(`/console/#tab=endpoints&slack=installed&team=${encodeURIComponent(j.team.name)}&team_id=${encodeURIComponent(j.team.id)}`, 302);
  });

  /** Slack workspaces this account installed the app in (for binding channels). */
  app.get("/v1/slack/teams", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const { results } = await c.env.DB.prepare("SELECT team_id, team_name, created_at FROM slack_teams WHERE account_id = ? ORDER BY created_at").bind(accountId).all<{ team_id: string; team_name: string; created_at: number }>();
    return c.json({ teams: results });
  });

  /** List Slack channel ↔ topic bindings for this account. */
  app.get("/v1/slack/bindings", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const { results } = await c.env.DB.prepare(
      `SELECT b.team_id, t.team_name, b.channel, b.topic, b.endpoint_id, b.created_at
         FROM slack_bindings b LEFT JOIN slack_teams t ON t.team_id = b.team_id AND t.account_id = b.account_id
        WHERE b.account_id = ? ORDER BY b.created_at DESC`,
    ).bind(accountId).all<{ team_id: string; team_name: string | null; channel: string; topic: string; endpoint_id: string | null; created_at: number }>();
    return c.json({ bindings: results });
  });

  /** Unbind a Slack channel from its topic (and remove the outbound endpoint if one was created). */
  app.delete("/v1/slack/bindings", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const teamId = c.req.query("team_id") ?? "", channel = c.req.query("channel") ?? "";
    if (!teamId || !channel) throw new ApiError("bad_request", "team_id and channel query parameters are required");
    const row = await c.env.DB.prepare("SELECT topic, endpoint_id FROM slack_bindings WHERE team_id = ? AND channel = ? AND account_id = ?").bind(teamId, channel, accountId).first<{ topic: string; endpoint_id: string | null }>();
    if (!row) throw new ApiError("not_found");
    await c.env.DB.prepare("DELETE FROM slack_bindings WHERE team_id = ? AND channel = ? AND account_id = ?").bind(teamId, channel, accountId).run();
    if (row.endpoint_id) {
      await c.env.DB.prepare("DELETE FROM subscriptions WHERE endpoint_id = ?").bind(row.endpoint_id).run();
      await c.env.DB.prepare("DELETE FROM endpoints WHERE id = ? AND account_id = ?").bind(row.endpoint_id, accountId).run();
      await syncTopicSubscriptions(c.env, row.topic);
    }
    await audit(c.env, accountId, p.kind, "slack.unbind", { team_id: teamId, channel, topic: row.topic });
    return c.json({ deleted: true });
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
      const existing = await c.env.DB.prepare("SELECT account_id FROM slack_bindings WHERE team_id = ? AND channel = ?").bind(body.team_id, body.channel).first<{ account_id: string }>();
      if (existing && existing.account_id !== accountId) throw new ApiError("conflict", "this channel is bound by another account");
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
