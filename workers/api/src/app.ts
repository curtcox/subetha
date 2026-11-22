// HTTP API: ntfy-compatible publish/subscribe plus the /v1 control plane (spec §8, PLAN §7).
import { Hono, type Context } from "hono";
import { canonicalize, isTopic, validateEnvelope, ulid, type Envelope, type Json } from "@subetha/sdk/protocol";
import { actionPriceMicros, topupSplit, tierFor, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { audit, autoCreateOwnerFor, createAccount, getAccount, invalidateAccount, recordTopic, validateHandle, validatePolicy } from "./accounts.ts";
import { authenticate, callerOf, invalidateToken, newTokenSecret, requireAdmin, scopeAllows, validateScopes, validateTransports } from "./auth.ts";
import { sha256Hex } from "./crypto.ts";
import { accountStub } from "./durable/account.ts";
import { topicStub, type SubscribeParams } from "./durable/topic.ts";
import { ApiError, reviveError, unwrap } from "./errors.ts";
import { parseFilter, parseHeaderPublish, parseJsonPublish, parseTopicPath, type ParsedPublish } from "./ntfy.ts";
import { createCheckoutSession, verifyStripeSignature } from "./stripe.ts";
import type { Env, Principal, TopicMeta } from "./types.ts";
import { registerControlRoutes } from "./control.ts";
import { mcpChallenge, registerMcp } from "./mcp.ts";
import { USAGE_LABELS } from "./usage.ts";

const PRICES = prices as unknown as PriceTable;
type C = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

export const app = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

app.onError((err, c) => {
  let e: unknown = err;
  try {
    reviveError(err);
  } catch (revived) {
    e = revived;
  }
  if (e instanceof ApiError) {
    const headers: Record<string, string> = e.code === "rate_limited" ? { "retry-after": "60" } : {};
    // MCP clients discover the authorization server from this challenge (RFC 9728), and
    // error="invalid_token" tells an OAuth client to refresh or sign in again.
    const url = new URL(c.req.url);
    if (e.code === "unauthorized" && url.pathname === "/mcp") headers["www-authenticate"] = mcpChallenge(url.origin, c.req.header("authorization") ? "invalid_token" : undefined);
    return e.toResponse(headers);
  }
  console.error(e);
  return new ApiError("internal").toResponse();
});

app.use("*", async (c, next) => {
  // CORS: the API is used from web pages with publishable tokens.
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": c.req.header("origin") ?? "*",
        "access-control-allow-methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "*",
        "access-control-max-age": "86400",
      },
    });
  }
  await next();
  if (c.res.status === 101) return;
  try {
    c.res.headers.set("access-control-allow-origin", c.req.header("origin") ?? "*");
  } catch {
    // Responses proxied from Durable Objects have immutable headers.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("access-control-allow-origin", c.req.header("origin") ?? "*");
  }
  c.res.headers.set("access-control-expose-headers", "x-cost-micros, x-message-id, retry-after");
});

// Device-signed requests must be verified before anything consumes the body.
app.use("*", async (c, next) => {
  if (c.req.header("x-device-id")) c.set("principal", await authenticate(c.req.raw, c.env));
  await next();
});

// Rate limits (PLAN §9): per identity for authenticated callers, per IP for anonymous ones.
// Provider hooks are exempt (they're signature-checked and must not be dropped), and so are static
// assets: one console page load is a dozen files, and serving one touches no DO, D1, or provider
// (a 429 would cost the same Worker invocation).
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/v1/hooks/") || path === "/v1/health" || path === "/v1/status") return next();
  if (isAssetRequest(c.req.method, path)) return next();
  const p = await principal(c);
  const limiter = p.kind === "anonymous" ? c.env.RL_ANON : c.env.RL_AUTH;
  if (limiter) {
    const key = p.kind === "anonymous" ? `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}` : p.kind === "token" ? `tok:${p.tokenId}` : p.kind === "device" ? `dev:${p.deviceId}` : `user:${p.clerkId}`;
    const { success } = await limiter.limit({ key });
    if (!success) throw new ApiError("rate_limited", "too many requests");
  }
  await next();
});

/** A GET the catch-all route hands to the static assets (site, docs, console, sdk.js). */
export function isAssetRequest(method: string, path: string): boolean {
  if (method !== "GET") return false;
  if (path.startsWith("/v1/") || path.startsWith("/file/") || path.startsWith("/.well-known/") || path === "/mcp") return false;
  try { return parseTopicPath(path) === null; } catch { return false; }
}

const principal = async (c: C) => {
  let p = c.get("principal");
  if (!p) {
    p = await authenticate(c.req.raw, c.env);
    c.set("principal", p);
  }
  return p;
};

app.get("/v1/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT, time: Math.floor(Date.now() / 1000) }));
app.get("/v1/prices", (c) => c.json(PRICES));

// Status page data (PLAN §14 Phase 3): component health and which transports are configured.
app.get("/v1/status", async (c) => {
  const timed = async (fn: () => Promise<unknown>) => {
    const t = Date.now();
    try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
  };
  const e = c.env;
  const [d1, kv, circuit] = await Promise.all([timed(() => e.DB.prepare("SELECT 1").first()), timed(() => e.CACHE.get("status:probe")), e.CACHE.get("circuit:telephony")]);
  const transports = {
    ws: true, sse: true, poll: true, mcp: true,
    webhook: !!e.DELIVERY,
    webpush: !!(e.DELIVERY && e.VAPID_PRIVATE_KEY),
    fcm: !!(e.DELIVERY && e.FCM_SERVICE_ACCOUNT),
    apns: !!(e.DELIVERY && e.APNS_KEY_P8),
    email: !!(e.DELIVERY && (e.EMAIL || e.SES_ACCESS_KEY_ID)),
    slack: !!(e.DELIVERY && e.SLACK_CLIENT_ID),
    sms: !!(e.DELIVERY && e.TWILIO_ACCOUNT_SID) && !circuit,
    voice: !!(e.DELIVERY && e.TWILIO_ACCOUNT_SID) && !circuit,
    lxmf: !!(e.DELIVERY && e.LXMF_GATEWAY_URL),
  };
  const ok = d1.ok && kv.ok;
  return c.json({ ok, environment: e.ENVIRONMENT, components: { d1, kv, queue: { ok: !!e.DELIVERY }, attachments: { ok: !!e.FILES } }, transports, telephony_circuit: circuit ?? null, time: Math.floor(Date.now() / 1000) }, ok ? 200 : 503);
});
app.get("/v1/config", (c) => c.json({ environment: c.env.ENVIRONMENT, clerk_publishable_key: c.env.CLERK_PUBLISHABLE_KEY ?? null, vapid_public_key: c.env.VAPID_PUBLIC_KEY ?? null }));

// ---------------- accounts ----------------
app.get("/v1/account", async (c) => {
  const id = requireAdmin(await principal(c));
  const acct = await getAccount(c.env, id);
  if (!acct) throw new ApiError("not_found");
  const bal = await accountStub(c.env, id).balance();
  return c.json({ id: acct.id, handle: acct.handle, email: acct.email, tier: tierFor(PRICES, acct.topups_12mo_micros), balance_usd_micros: bal.available, reserved_usd_micros: bal.reserved, daily_cap_micros: acct.daily_cap_micros, oauth_daily_cap_micros: acct.oauth_daily_cap_micros ?? null, paused: !!acct.paused, created_at: acct.created_at });
});

app.post("/v1/account", async (c) => {
  const p = await principal(c);
  if (p.kind !== "user") throw new ApiError("unauthorized", "sign in with Clerk to create an account");
  if (p.accountId) throw new ApiError("conflict", "account already exists");
  const body = (await c.req.json().catch(() => ({}))) as { handle?: string; email?: string };
  const handle = body.handle === undefined ? null : validateHandle(body.handle);
  const acct = await createAccount(c.env, { handle, clerkId: p.clerkId, email: body.email ?? null });
  await accountStub(c.env, acct.id).setAccountId(acct.id);
  await audit(c.env, acct.id, p.clerkId, "account.create", { handle });
  return c.json({ id: acct.id, handle: acct.handle }, 201);
});

app.patch("/v1/account", async (c) => {
  const id = requireAdmin(await principal(c));
  const body = (await c.req.json()) as { handle?: string; daily_cap_micros?: number | null; oauth_daily_cap_micros?: number | null; paused?: boolean; auto_recharge?: { threshold_usd: number; amount_usd: number } | null };
  const acct = await getAccount(c.env, id);
  if (body.auto_recharge !== undefined) {
    if (body.auto_recharge === null) {
      await accountStub(c.env, id).setAutoRecharge(null);
      await c.env.DB.prepare("UPDATE accounts SET auto_recharge = NULL WHERE id = ?").bind(id).run();
    } else {
      const customer = (acct as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
      if (!customer) throw new ApiError("conflict", "top up once with save_card: true to store a card first");
      const threshold = Math.round(Number(body.auto_recharge.threshold_usd) * 1e6), amount = Math.round(Number(body.auto_recharge.amount_usd) * 1e6);
      try { topupSplit(PRICES, amount); } catch { throw new ApiError("bad_request", "amount_usd is outside the allowed top-up range"); }
      if (!(threshold >= 0 && threshold < amount)) throw new ApiError("bad_request", "threshold_usd must be ≥ 0 and below amount_usd");
      const cfg = { threshold_micros: threshold, amount_micros: amount };
      await accountStub(c.env, id).setAutoRecharge({ ...cfg, customer });
      await c.env.DB.prepare("UPDATE accounts SET auto_recharge = ? WHERE id = ?").bind(JSON.stringify(cfg), id).run();
    }
  }
  if (body.handle !== undefined) {
    if (acct?.handle) throw new ApiError("conflict", "handle can't be changed once set");
    await c.env.DB.prepare("UPDATE accounts SET handle = ? WHERE id = ?").bind(validateHandle(body.handle), id).run().catch((e) => {
      throw String(e).includes("UNIQUE") ? new ApiError("conflict", "handle taken") : e;
    });
  }
  if (body.daily_cap_micros !== undefined) await c.env.DB.prepare("UPDATE accounts SET daily_cap_micros = ? WHERE id = ?").bind(body.daily_cap_micros, id).run();
  if (body.paused !== undefined) await c.env.DB.prepare("UPDATE accounts SET paused = ? WHERE id = ?").bind(body.paused ? 1 : 0, id).run();
  if (body.oauth_daily_cap_micros !== undefined) {
    const v = body.oauth_daily_cap_micros;
    if (v !== null && !(Number.isInteger(v) && v >= 0)) throw new ApiError("bad_request", "oauth_daily_cap_micros must be a non-negative integer or null");
    await c.env.DB.prepare("UPDATE accounts SET oauth_daily_cap_micros = ? WHERE id = ?").bind(v, id).run();
  }
  if (body.daily_cap_micros !== undefined || body.paused !== undefined) {
    const row = await c.env.DB.prepare("SELECT paused, daily_cap_micros FROM accounts WHERE id = ?").bind(id).first<{ paused: number; daily_cap_micros: number | null }>();
    await accountStub(c.env, id).setControls({ paused: !!row?.paused, dailyCapMicros: row?.daily_cap_micros ?? null });
  }
  await invalidateAccount(c.env, id);
  await audit(c.env, id, actorOf(await principal(c)), "account.update", body);
  return c.json(await getAccount(c.env, id));
});

app.get("/v1/balance", async (c) => {
  const id = requireAdmin(await principal(c));
  const b = await accountStub(c.env, id).balance();
  return c.json({ available_usd_micros: b.available, reserved_usd_micros: b.reserved });
});

app.get("/v1/ledger", async (c) => {
  const id = requireAdmin(await principal(c));
  const after = Number(c.req.query("after") ?? 0);
  return c.json({ entries: await accountStub(c.env, id).entries(after, Number(c.req.query("limit") ?? 100)) });
});

app.get("/v1/usage", async (c) => {
  const id = requireAdmin(await principal(c));
  const days = Math.min(Math.max(Math.floor(Number(c.req.query("days") ?? 30)) || 30, 1), 90);
  return c.json({ categories: USAGE_LABELS, ...(await accountStub(c.env, id).usage(days)) });
});

app.get("/v1/audit", async (c) => {
  const id = requireAdmin(await principal(c));
  const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const { results } = await c.env.DB.prepare("SELECT id, actor, action, detail, time FROM audit_log WHERE account_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
    .bind(id, before, limit).all<{ id: number; actor: string; action: string; detail: string | null; time: number }>();
  const entries = results.map((r) => {
    let detail: unknown = r.detail;
    try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { /* stored as text */ }
    return { ...r, detail };
  });
  return c.json({ entries, next_before: entries.length === limit ? entries[entries.length - 1]!.id : null });
});

// ---------------- billing ----------------
app.post("/v1/billing/checkout", async (c) => {
  const id = requireAdmin(await principal(c));
  const body = (await c.req.json()) as { amount_usd?: number; success_url?: string; cancel_url?: string; save_card?: boolean };
  const amountMicros = Math.round(Number(body.amount_usd) * 1e6);
  try {
    topupSplit(PRICES, amountMicros);
  } catch {
    throw new ApiError("bad_request", `amount_usd must be between ${PRICES.topup.min_usd_micros / 1e6} and ${PRICES.topup.max_usd_micros / 1e6}`);
  }
  const acct = await getAccount(c.env, id);
  const base = c.env.BASE_URL;
  const s = await createCheckoutSession(c.env, { accountId: id, amountMicros, successUrl: body.success_url ?? `${base}/console/#tab=billing&topup=ok`, cancelUrl: body.cancel_url ?? `${base}/console/#tab=billing`, email: acct?.email, saveCard: !!body.save_card, customer: (acct as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null });
  return c.json({ id: s.id, url: s.url, ...topupSplit(PRICES, amountMicros) });
});

app.post("/v1/hooks/stripe", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) throw new ApiError("provider_unavailable");
  const payload = await c.req.text();
  if (!(await verifyStripeSignature(payload, c.req.header("stripe-signature") ?? null, c.env.STRIPE_WEBHOOK_SECRET))) throw new ApiError("unauthorized", "bad Stripe signature");
  const evt = JSON.parse(payload) as { id: string; type: string; data: { object: Record<string, unknown> } };
  const seen = await c.env.DB.prepare("SELECT 1 FROM stripe_events WHERE id = ?").bind(evt.id).first();
  if (seen) return c.json({ received: true, duplicate: true });
  const obj = evt.data.object;
  if (evt.type === "checkout.session.completed" && obj.payment_status === "paid") {
    const meta = obj.metadata as { account_id?: string } | undefined;
    const accountId = meta?.account_id;
    const amountMicros = Number(obj.amount_total) * 10_000;
    if (!accountId) throw new ApiError("bad_request", "missing account_id metadata");
    const { creditMicros, feeMicros } = topupSplit(PRICES, amountMicros);
    await accountStub(c.env, accountId).topup(creditMicros, String(obj.id), `stripe amount=${amountMicros} fee=${feeMicros}`);
    if (typeof obj.payment_intent === "string") await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_payments (payment_intent, account_id, amount_micros, created_at) VALUES (?, ?, ?, ?)").bind(obj.payment_intent, accountId, amountMicros, Date.now()).run();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO stripe_events (id, type, account_id, amount_micros, created_at) VALUES (?, ?, ?, ?, ?)").bind(evt.id, evt.type, accountId, amountMicros, Date.now()),
      c.env.DB.prepare("UPDATE accounts SET topups_12mo_micros = topups_12mo_micros + ?, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?").bind(amountMicros, typeof obj.customer === "string" ? obj.customer : null, accountId),
    ]);
    await invalidateAccount(c.env, accountId);
  } else if ((evt.type === "payment_intent.succeeded" || evt.type === "payment_intent.payment_failed") && (obj.metadata as Record<string, string> | undefined)?.auto_recharge === "1") {
    const accountId = (obj.metadata as Record<string, string>).account_id!;
    const amountMicros = Number(obj.amount) * 10_000;
    if (evt.type === "payment_intent.succeeded") {
      const { creditMicros, feeMicros } = topupSplit(PRICES, amountMicros);
      await accountStub(c.env, accountId).topup(creditMicros, String(obj.id), `auto-recharge amount=${amountMicros} fee=${feeMicros}`);
      await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_payments (payment_intent, account_id, amount_micros, created_at) VALUES (?, ?, ?, ?)").bind(String(obj.id), accountId, amountMicros, Date.now()).run();
      await c.env.DB.prepare("UPDATE accounts SET topups_12mo_micros = topups_12mo_micros + ? WHERE id = ?").bind(amountMicros, accountId).run();
    } else {
      await accountStub(c.env, accountId).autoRechargeFailed("card declined");
      await c.env.DB.prepare("UPDATE accounts SET auto_recharge = NULL WHERE id = ?").bind(accountId).run();
      await audit(c.env, accountId, "stripe", "auto_recharge.failed", { pi: obj.id });
    }
    await c.env.DB.prepare("INSERT INTO stripe_events (id, type, account_id, amount_micros, created_at) VALUES (?, ?, ?, ?, ?)").bind(evt.id, evt.type, accountId, amountMicros, Date.now()).run();
    await invalidateAccount(c.env, accountId);
  } else if (evt.type === "charge.dispute.created" || evt.type === "charge.refunded") {
    // Both objects carry payment_intent; map it back to the account we credited.
    const pi = String(obj.payment_intent ?? "");
    const pay = await c.env.DB.prepare("SELECT * FROM stripe_payments WHERE payment_intent = ?").bind(pi).first<{ account_id: string; amount_micros: number; refunded_micros: number; disputed: number }>();
    let deducted = 0;
    if (pay) {
      if (evt.type === "charge.dispute.created" && !pay.disputed) {
        deducted = Number(obj.amount ?? 0) * 10_000 + 15_000_000; // disputed amount + Stripe's dispute fee, recovered where possible
        await c.env.DB.prepare("UPDATE stripe_payments SET disputed = 1 WHERE payment_intent = ?").bind(pi).run();
        const r = await accountStub(c.env, pay.account_id).adjust(-deducted, `dispute:${pi}`, "chargeback");
        if (r.unrecovered) await audit(c.env, pay.account_id, "stripe", "chargeback.unrecovered", { micros: r.unrecovered });
      } else if (evt.type === "charge.refunded") {
        const total = Number(obj.amount_refunded ?? 0) * 10_000;
        deducted = Math.max(0, total - pay.refunded_micros); // only the newly refunded part
        if (deducted) {
          await c.env.DB.prepare("UPDATE stripe_payments SET refunded_micros = ? WHERE payment_intent = ?").bind(total, pi).run();
          await accountStub(c.env, pay.account_id).adjust(-deducted, `refund:${pi}:${total}`, "refund: stripe");
        }
      }
    }
    await c.env.DB.prepare("INSERT INTO stripe_events (id, type, account_id, amount_micros, created_at) VALUES (?, ?, ?, ?, ?)").bind(evt.id, evt.type, pay?.account_id ?? null, deducted, Date.now()).run();
  } else {
    await c.env.DB.prepare("INSERT INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)").bind(evt.id, evt.type, Date.now()).run();
  }
  return c.json({ received: true });
});

// ---------------- tokens ----------------
app.get("/v1/tokens", async (c) => {
  const id = requireAdmin(await principal(c));
  const { results } = await c.env.DB.prepare("SELECT id, name, scopes, transports, daily_cap_micros, total_cap_micros, origins, expires_at, created_at, revoked_at FROM tokens WHERE account_id = ? ORDER BY created_at DESC").bind(id).all();
  return c.json({ tokens: results.map((r) => ({ ...r, scopes: JSON.parse(r.scopes as string), transports: r.transports ? JSON.parse(r.transports as string) : null, origins: r.origins ? JSON.parse(r.origins as string) : null })) });
});

app.post("/v1/tokens", async (c) => {
  const p = await principal(c);
  const id = requireAdmin(p);
  const body = (await c.req.json()) as { name?: string; scopes?: unknown; transports?: unknown; daily_cap_usd?: number; total_cap_usd?: number; origins?: string[]; expires_in_s?: number };
  const scopes = validateScopes(body.scopes);
  const transports = validateTransports(body.transports);
  if (body.origins && (!Array.isArray(body.origins) || !body.origins.every((o) => /^https?:\/\/[^/]+$/.test(o)))) throw new ApiError("bad_request", "origins must be like https://example.com");
  if (body.origins?.length && (scopes.length !== 1 || !/^(publish|subscribe):(@[a-z0-9-]+\/[A-Za-z0-9_-]+|t_[a-z2-7]{26})$/.test(scopes[0]!))) throw new ApiError("bad_request", "publishable (origin-bound) tokens must have exactly one non-wildcard topic scope");
  if (body.origins?.length && body.daily_cap_usd === undefined) throw new ApiError("bad_request", "publishable tokens need a daily_cap_usd");
  // A token can't grant more than its creator has.
  if (p.kind === "token" && !scopeAllows(p.scopes, "admin")) throw new ApiError("forbidden");
  const t = await newTokenSecret();
  const cap = (usd?: number) => (usd === undefined ? null : Math.round(usd * 1e6));
  await c.env.DB.prepare("INSERT INTO tokens (id, account_id, secret_hash, name, scopes, transports, daily_cap_micros, total_cap_micros, origins, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(t.id, id, t.hash, body.name ?? "", JSON.stringify(scopes), transports ? JSON.stringify(transports) : null, cap(body.daily_cap_usd), cap(body.total_cap_usd), body.origins?.length ? JSON.stringify(body.origins) : null, body.expires_in_s ? Date.now() + body.expires_in_s * 1000 : null, Date.now()).run();
  await audit(c.env, id, actorOf(p), "token.create", { id: t.id, scopes });
  return c.json({ id: t.id, token: t.token, scopes, note: "The token is shown once. Store it securely." }, 201);
});

app.delete("/v1/tokens/:id", async (c) => {
  const p = await principal(c);
  const id = requireAdmin(p);
  const r = await c.env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(Date.now(), c.req.param("id"), id).run();
  if (!r.meta.changes) throw new ApiError("not_found");
  await invalidateToken(c.env, c.req.param("id"));
  await audit(c.env, id, actorOf(p), "token.revoke", { id: c.req.param("id") });
  return c.json({ revoked: true });
});

// ---------------- topics ----------------
app.get("/v1/topics", async (c) => {
  const id = requireAdmin(await principal(c));
  const { results } = await c.env.DB.prepare("SELECT name, policy, created_at FROM topics WHERE owner_account_id = ? ORDER BY name").bind(id).all();
  return c.json({ topics: results.map((r) => ({ name: r.name, policy: JSON.parse(r.policy as string), created_at: r.created_at })) });
});

app.get("/v1/topics/:topic{.+}", async (c) => {
  const id = requireAdmin(await principal(c));
  const name = c.req.param("topic");
  const meta = await topicStub(c.env, name).getMeta();
  if (!meta || meta.owner !== id) throw new ApiError("not_found");
  return c.json(meta);
});

app.put("/v1/topics/:topic{.+}", async (c) => {
  const p = await principal(c);
  const id = requireAdmin(p);
  const name = c.req.param("topic");
  if (!isTopic(name)) throw new ApiError("invalid_topic");
  const body = (await c.req.json().catch(() => ({}))) as { policy?: unknown };
  const policy = validatePolicy(body.policy ?? {});
  const stub = topicStub(c.env, name);
  const existing = await stub.getMeta();
  if (existing && existing.owner !== id) throw new ApiError("forbidden", "topic belongs to another account");
  if (!existing && (await autoCreateOwnerFor(c.env, id, name)) !== id) throw new ApiError("forbidden", "you can only create topics in your own @handle namespace or secret t_ topics");
  const acct = await getAccount(c.env, id);
  const meta: TopicMeta & { tier: string } = { name, owner: id, policy, created_at: existing?.created_at ?? Date.now(), tier: tierFor(PRICES, acct?.topups_12mo_micros ?? 0) };
  await stub.configure(meta);
  await recordTopic(c.env, meta);
  await audit(c.env, id, actorOf(p), existing ? "topic.update" : "topic.create", { name, policy });
  return c.json(meta, existing ? 200 : 201);
});

app.get("/v1/traces/:id", async (c) => {
  const p = await principal(c);
  requireAdmin(p);
  const topic = c.req.query("topic");
  if (!topic || !isTopic(topic)) throw new ApiError("bad_request", "?topic= is required");
  const t = unwrap(await topicStub(c.env, topic).getTrace(c.req.param("id"), callerOf(p)));
  if (!t) throw new ApiError("not_found");
  return c.json(t);
});

app.post("/v1/ack", async (c) => {
  const p = await principal(c);
  const body = (await c.req.json()) as { topic?: string; id?: string; via?: string };
  if (!body.topic || !isTopic(body.topic) || !body.id) throw new ApiError("bad_request", "topic and id are required");
  if (p.kind === "token" && !scopeAllows(p.scopes, "subscribe", body.topic)) throw new ApiError("forbidden", "token lacks subscribe scope for this topic");
  unwrap(await topicStub(c.env, body.topic).ackAs(body.id, String(body.via ?? "http").slice(0, 16), callerOf(p)));
  return c.json({ acked: true });
});

registerControlRoutes(app, principal);
registerMcp(app);

// ---------------- local development ----------------
app.post("/v1/dev/bootstrap", async (c) => {
  if (c.env.ENVIRONMENT !== "local" || !c.env.DEV_BOOTSTRAP_SECRET) throw new ApiError("not_found");
  const body = (await c.req.json()) as { secret?: string; handle?: string; credit_usd?: number };
  if (body.secret !== c.env.DEV_BOOTSTRAP_SECRET) throw new ApiError("unauthorized");
  const acct = await createAccount(c.env, { handle: body.handle ? validateHandle(body.handle) : null, clerkId: null });
  await accountStub(c.env, acct.id).setAccountId(acct.id);
  if (body.credit_usd) await accountStub(c.env, acct.id).topup(Math.round(body.credit_usd * 1e6), `dev:${ulid()}`, "dev bootstrap");
  const t = await newTokenSecret();
  await c.env.DB.prepare("INSERT INTO tokens (id, account_id, secret_hash, name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(t.id, acct.id, t.hash, "dev", JSON.stringify(["admin"]), Date.now()).run();
  return c.json({ account_id: acct.id, handle: acct.handle, token: t.token }, 201);
});

// ---------------- ntfy-compatible publish / subscribe ----------------
async function doPublish(c: C, parsed: ParsedPublish): Promise<Response> {
  const p = await principal(c);
  const env = parsed.envelope;
  if (!isTopic(env.topic)) throw new ApiError("invalid_topic");
  if (p.kind === "token" && !scopeAllows(p.scopes, "publish", env.topic)) throw new ApiError("forbidden", "token lacks publish scope for this topic");
  const problems = validateEnvelope(env);
  if (problems.length) throw new ApiError("invalid_message", problems.join("; "));
  const caller = callerOf(p);
  // Attachments go to R2 first; the publish (which charges for them) references the file.
  let fileId: string | null = null;
  if (parsed.file) {
    if (!c.env.FILES) throw new ApiError("unsupported", "attachments are not enabled");
    fileId = ulid().toLowerCase();
    env.attachment = { name: parsed.file.name, url: `${c.env.BASE_URL}/file/${fileId}/${encodeURIComponent(parsed.file.name)}`, size: parsed.file.bytes.length, type: parsed.file.type };
    if (!parsed.dryRun) await c.env.FILES.put(`att/${fileId}`, parsed.file.bytes, { httpMetadata: { contentType: parsed.file.type } });
  }
  const bodyHash = await sha256Hex(canonicalize({ ...env, route: parsed.route, file: parsed.file ? await sha256Hex(parsed.file.bytes) : undefined } as unknown as Json));
  let result;
  try {
    result = unwrap(await topicStub(c.env, env.topic).publish({
      envelope: env,
      caller,
      autoCreateOwner: await autoCreateOwnerFor(c.env, caller.accountId, env.topic),
      idempotencyKey: parsed.idempotencyKey,
      bodyHash,
      dryRun: parsed.dryRun,
      attachmentBytes: parsed.file?.bytes.length,
      route: parsed.route,
    }));
  } catch (e) {
    if (fileId && !parsed.dryRun) await c.env.FILES!.delete(`att/${fileId}`);
    throw e;
  }
  if (fileId && !parsed.dryRun) {
    if (result.duplicate) await c.env.FILES!.delete(`att/${fileId}`);
    else {
      const meta = await topicStub(c.env, env.topic).getMeta();
      await c.env.DB.prepare("INSERT INTO files (id, topic, owner_account_id, name, type, size, message_id, expires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(fileId, env.topic, meta!.owner, parsed.file!.name, parsed.file!.type, parsed.file!.bytes.length, result.message.id, result.message.expires, Date.now()).run();
    }
  }
  if (result.created_topic) c.executionCtx.waitUntil(recordTopic(c.env, { name: env.topic, owner: caller.accountId!, policy: {}, created_at: Date.now() }));
  const headers = { "x-cost-micros": String(result.cost_micros), "x-message-id": result.message.id ?? "" };
  if (result.dry_run) return c.json({ dry_run: true, estimate_usd_micros: result.cost_micros, plan: result.plan, message: result.message }, 200, headers);
  return c.json(result.message, 200, result.duplicate ? { ...headers, "x-duplicate": "1" } : headers);
}

app.get("/file/:id/:name?", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(c.req.param("id")).first<{ id: string; owner_account_id: string; name: string; type: string; expires: number }>();
  if (!row || !c.env.FILES || row.expires < Math.floor(Date.now() / 1000)) throw new ApiError("not_found", "attachment expired or not found");
  // Downloads are metered like any other request, paid by the topic owner.
  const charge = await accountStub(c.env, row.owner_account_id).charge(actionPriceMicros(PRICES, "api_request"), `dl:${row.id}:${ulid()}`, null, {});
  if (!charge.ok) throw new ApiError("insufficient_balance", "the topic owner's balance can't cover this download");
  const obj = await c.env.FILES.get(`att/${row.id}`);
  if (!obj) throw new ApiError("not_found");
  const inline = /^(image|video|audio)\/|^text\/plain|^application\/pdf/.test(row.type);
  return new Response(obj.body, { headers: {
    "content-type": inline ? row.type : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=3600",
  } });
});

app.post("/", async (c) => {
  if (!(c.req.header("content-type") ?? "").includes("json") && !(await c.req.raw.clone().text()).trim().startsWith("{")) throw new ApiError("bad_request", "POST / expects a JSON message");
  return doPublish(c, await parseJsonPublish(c.req.raw));
});

function mergeStreams(responses: Response[], format: string): ReadableStream<Uint8Array> {
  const sep = format === "sse" ? "\n\n" : "\n";
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = responses.length;
  for (const r of responses) {
    (async () => {
      const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf(sep)) >= 0) {
            await writer.write(enc.encode(buf.slice(0, i + sep.length)));
            buf = buf.slice(i + sep.length);
          }
        }
      } catch {
        /* upstream closed */
      } finally {
        if (--open === 0) writer.close().catch(() => {});
      }
    })();
  }
  return readable;
}

async function doSubscribe(c: C, topics: string[], format: string): Promise<Response> {
  const p = await principal(c);
  for (const t of topics) if (p.kind === "token" && !scopeAllows(p.scopes, "subscribe", t)) throw new ApiError("forbidden", `token lacks subscribe scope for ${t}`);
  const url = new URL(c.req.url);
  const poll = ["1", "true", "yes"].includes(url.searchParams.get("poll") ?? "");
  const params: SubscribeParams = { format: format as SubscribeParams["format"], since: url.searchParams.get("since"), filter: parseFilter(url), caller: callerOf(p), poll };

  if (format === "auth") {
    for (const t of topics) {
      const meta = await topicStub(c.env, t).getMeta();
      if (!meta) throw new ApiError("not_found");
    }
    return c.json({ success: true });
  }

  if (poll) {
    const all = (await Promise.all(topics.map(async (t) => unwrap(await topicStub(c.env, t).poll(params))))).flat();
    all.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.id ?? "").localeCompare(b.id ?? ""));
    if (format === "raw") return c.text(all.map((m) => (m.message ?? "").replace(/\n/g, " ")).join("\n") + (all.length ? "\n" : ""));
    if (format === "sse") return new Response(all.map((m) => `id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    return new Response(all.map((m) => JSON.stringify(m) + "\n").join(""), { headers: { "content-type": "application/x-ndjson" } });
  }

  if (format === "ws") {
    if (topics.length !== 1) throw new ApiError("bad_request", "WebSocket subscriptions take one topic");
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new ApiError("bad_request", "expected a WebSocket upgrade");
  }
  const responses = await Promise.all(topics.map((t) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-subetha-subscribe", JSON.stringify(params));
    return topicStub(c.env, t).fetch(new Request(c.req.url, { headers }));
  }));
  for (const r of responses) {
    if (r.status === 101 || r.ok) continue;
    const text = await r.text();
    if (text.startsWith("ApiError:")) reviveError(new Error(text));
    throw new ApiError(r.status === 402 ? "insufficient_balance" : r.status === 404 ? "not_found" : "forbidden", text);
  }
  if (format === "ws" || responses.length === 1) return responses[0]!;
  return new Response(mergeStreams(responses, format), { headers: responses[0]!.headers });
}

app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const tp = parseTopicPath(url.pathname);
  if (!tp) {
    if (c.env.ASSETS && c.req.method === "GET") return c.env.ASSETS.fetch(c.req.raw);
    throw new ApiError("not_found");
  }
  const method = c.req.method;
  if ((method === "PUT" || method === "POST") && !tp.format) {
    if (tp.topics.length !== 1) throw new ApiError("bad_request", "publish to one topic at a time");
    return doPublish(c, await parseHeaderPublish(c.req.raw, tp.topics[0]!));
  }
  if (method === "GET" && tp.format) return doSubscribe(c, tp.topics, tp.format);
  if (method === "GET" && !tp.format) {
    // ntfy's "publish via GET": /<topic>/publish?message=… is not supported; browsers get the console.
    return c.redirect(`/console/#topic=${encodeURIComponent(tp.topics.join(","))}`, 302);
  }
  throw new ApiError("bad_request", `unsupported method ${method}`);
});

export function actorOf(p: Principal): string {
  return p.kind === "token" ? `token:${p.tokenId}` : p.kind === "user" ? `user:${p.clerkId}` : p.kind === "device" ? `device:${p.deviceId}` : "anonymous";
}

export type { Envelope };
