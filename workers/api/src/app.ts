// HTTP API: ntfy-compatible publish/subscribe plus the /v1 control plane (spec §8, PLAN §7).
import { Hono, type Context } from "hono";
import { canonicalize, isTopic, validateEnvelope, ulid, type Envelope, type Json } from "@subetha/sdk/protocol";
import { topupSplit, tierFor, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { audit, autoCreateOwnerFor, createAccount, getAccount, invalidateAccount, recordTopic, validateHandle, validatePolicy } from "./accounts.ts";
import { authenticate, callerOf, invalidateToken, newTokenSecret, requireAccount, requireAdmin, scopeAllows, validateScopes, validateTransports } from "./auth.ts";
import { sha256Hex } from "./crypto.ts";
import { accountStub } from "./durable/account.ts";
import { topicStub, type SubscribeParams } from "./durable/topic.ts";
import { ApiError, reviveError, unwrap } from "./errors.ts";
import { parseFilter, parseHeaderPublish, parseJsonPublish, parseTopicPath, type ParsedPublish } from "./ntfy.ts";
import { createCheckoutSession, verifyStripeSignature } from "./stripe.ts";
import type { Env, Principal, TopicMeta } from "./types.ts";
import { registerControlRoutes } from "./control.ts";

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
  if (e instanceof ApiError) return e.toResponse(e.code === "rate_limited" ? { "retry-after": "60" } : {});
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
app.get("/v1/config", (c) => c.json({ environment: c.env.ENVIRONMENT, clerk_publishable_key: c.env.CLERK_PUBLISHABLE_KEY ?? null, vapid_public_key: c.env.VAPID_PUBLIC_KEY ?? null }));

// ---------------- accounts ----------------
app.get("/v1/account", async (c) => {
  const id = requireAccount(await principal(c));
  const acct = await getAccount(c.env, id);
  if (!acct) throw new ApiError("not_found");
  const bal = await accountStub(c.env, id).balance();
  return c.json({ id: acct.id, handle: acct.handle, email: acct.email, tier: tierFor(PRICES, acct.topups_12mo_micros), balance_usd_micros: bal.available, reserved_usd_micros: bal.reserved, created_at: acct.created_at });
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
  const body = (await c.req.json()) as { handle?: string; daily_cap_micros?: number | null; paused?: boolean };
  const acct = await getAccount(c.env, id);
  if (body.handle !== undefined) {
    if (acct?.handle) throw new ApiError("conflict", "handle can't be changed once set");
    await c.env.DB.prepare("UPDATE accounts SET handle = ? WHERE id = ?").bind(validateHandle(body.handle), id).run().catch((e) => {
      throw String(e).includes("UNIQUE") ? new ApiError("conflict", "handle taken") : e;
    });
  }
  if (body.daily_cap_micros !== undefined) await c.env.DB.prepare("UPDATE accounts SET daily_cap_micros = ? WHERE id = ?").bind(body.daily_cap_micros, id).run();
  if (body.paused !== undefined) await c.env.DB.prepare("UPDATE accounts SET paused = ? WHERE id = ?").bind(body.paused ? 1 : 0, id).run();
  await invalidateAccount(c.env, id);
  await audit(c.env, id, actorOf(await principal(c)), "account.update", body);
  return c.json(await getAccount(c.env, id));
});

app.get("/v1/balance", async (c) => {
  const id = requireAccount(await principal(c));
  const b = await accountStub(c.env, id).balance();
  return c.json({ available_usd_micros: b.available, reserved_usd_micros: b.reserved });
});

app.get("/v1/ledger", async (c) => {
  const id = requireAccount(await principal(c));
  const after = Number(c.req.query("after") ?? 0);
  return c.json({ entries: await accountStub(c.env, id).entries(after, Number(c.req.query("limit") ?? 100)) });
});

// ---------------- billing ----------------
app.post("/v1/billing/checkout", async (c) => {
  const id = requireAdmin(await principal(c));
  const body = (await c.req.json()) as { amount_usd?: number; success_url?: string; cancel_url?: string };
  const amountMicros = Math.round(Number(body.amount_usd) * 1e6);
  try {
    topupSplit(PRICES, amountMicros);
  } catch {
    throw new ApiError("bad_request", `amount_usd must be between ${PRICES.topup.min_usd_micros / 1e6} and ${PRICES.topup.max_usd_micros / 1e6}`);
  }
  const acct = await getAccount(c.env, id);
  const base = c.env.BASE_URL;
  const s = await createCheckoutSession(c.env, { accountId: id, amountMicros, successUrl: body.success_url ?? `${base}/console/#billing?ok=1`, cancelUrl: body.cancel_url ?? `${base}/console/#billing`, email: acct?.email });
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
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO stripe_events (id, type, account_id, amount_micros, created_at) VALUES (?, ?, ?, ?, ?)").bind(evt.id, evt.type, accountId, amountMicros, Date.now()),
      c.env.DB.prepare("UPDATE accounts SET topups_12mo_micros = topups_12mo_micros + ? WHERE id = ?").bind(amountMicros, accountId),
    ]);
    await invalidateAccount(c.env, accountId);
  } else if (evt.type === "charge.dispute.created" || evt.type === "charge.refunded") {
    const accountId = ((obj.metadata as Record<string, string> | undefined)?.account_id) ?? null;
    const amount = Number(obj.amount ?? obj.amount_refunded ?? 0) * 10_000;
    if (accountId && amount > 0) {
      const fee = evt.type === "charge.dispute.created" ? 15_000_000 : 0; // dispute fee recovered where possible
      const r = await accountStub(c.env, accountId).adjust(-(amount + fee), evt.id, evt.type === "charge.refunded" ? "refund: stripe" : "chargeback");
      if (r.unrecovered) await audit(c.env, accountId, "stripe", "chargeback.unrecovered", { micros: r.unrecovered });
    }
    await c.env.DB.prepare("INSERT INTO stripe_events (id, type, account_id, amount_micros, created_at) VALUES (?, ?, ?, ?, ?)").bind(evt.id, evt.type, accountId, amount, Date.now()).run();
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
  if (body.origins?.length && (scopes.length !== 1 || scopes[0] === "admin" || scopes[0]!.endsWith("*"))) throw new ApiError("bad_request", "publishable (origin-bound) tokens must have exactly one non-wildcard topic scope");
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
  const id = requireAccount(await principal(c));
  const { results } = await c.env.DB.prepare("SELECT name, policy, created_at FROM topics WHERE owner_account_id = ? ORDER BY name").bind(id).all();
  return c.json({ topics: results.map((r) => ({ name: r.name, policy: JSON.parse(r.policy as string), created_at: r.created_at })) });
});

app.get("/v1/topics/:topic{.+}", async (c) => {
  const id = requireAccount(await principal(c));
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
  requireAccount(p);
  const topic = c.req.query("topic");
  if (!topic || !isTopic(topic)) throw new ApiError("bad_request", "?topic= is required");
  const t = unwrap(await topicStub(c.env, topic).getTrace(c.req.param("id"), callerOf(p)));
  if (!t) throw new ApiError("not_found");
  return c.json(t);
});

app.post("/v1/ack", async (c) => {
  const body = (await c.req.json()) as { topic?: string; id?: string; via?: string };
  if (!body.topic || !isTopic(body.topic) || !body.id) throw new ApiError("bad_request", "topic and id are required");
  await topicStub(c.env, body.topic).ack(body.id, body.via ?? "http");
  return c.json({ acked: true });
});

registerControlRoutes(app, principal);

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
  const bodyHash = await sha256Hex(canonicalize({ ...env, route: parsed.route } as unknown as Json));
  const result = unwrap(await topicStub(c.env, env.topic).publish({
    envelope: env,
    caller,
    autoCreateOwner: await autoCreateOwnerFor(c.env, caller.accountId, env.topic),
    idempotencyKey: parsed.idempotencyKey,
    bodyHash,
    dryRun: parsed.dryRun,
    route: parsed.route,
  }));
  if (result.created_topic) c.executionCtx.waitUntil(recordTopic(c.env, { name: env.topic, owner: caller.accountId!, policy: {}, created_at: Date.now() }));
  const headers = { "x-cost-micros": String(result.cost_micros), "x-message-id": result.message.id ?? "" };
  if (result.dry_run) return c.json({ dry_run: true, estimate_usd_micros: result.cost_micros, plan: result.plan, message: result.message }, 200, headers);
  return c.json(result.message, 200, result.duplicate ? { ...headers, "x-duplicate": "1" } : headers);
}

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
