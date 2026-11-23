// Wrapped topic keys (spec §5.1, PLAN §9): a topic owner uploads E2EE topic keys sealed to
// enrolled devices; each device fetches the ones addressed to it. The relay can't open them.
import type { Context, Hono } from "hono";
import { actionPriceMicros, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { isTopic, isWrappedKey, ulid, type WrappedKey } from "@subetha/sdk/protocol";
import { accountTier, audit } from "./accounts.ts";
import { callerOf, requireAccount, requireAdmin } from "./auth.ts";
import { accountStub } from "./durable/account.ts";
import { ApiError } from "./errors.ts";
import type { Env, Principal } from "./types.ts";

const PRICES = prices as unknown as PriceTable;
type Vars = { Bindings: Env; Variables: { principal: Principal } };
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

const actor = (p: Principal) => (p.kind === "token" ? `token:${p.tokenId}` : p.kind === "user" ? `user:${p.clerkId}` : p.kind);

export const MAX_KEYS_PER_REQUEST = 100;
export const MAX_KEYS_PER_TOPIC = 1000;

/** Key-store calls are metered like other API requests (PLAN §8 rule 0), paid by the caller's account. */
async function meter(env: Env, accountId: string, p: Principal, what: string) {
  const tier = await accountTier(env, accountId);
  const caller = callerOf(p);
  const r = await accountStub(env, accountId).charge(
    actionPriceMicros(PRICES, "api_request", tier),
    `keys:${what}:${ulid()}`,
    caller.tokenId,
    { tokenDaily: caller.caps.daily, tokenTotal: caller.caps.total },
  );
  if (!r.ok) {
    if (r.code === "insufficient_balance") throw new ApiError("insufficient_balance", "balance too low for this request", { shortfall_usd_micros: r.shortfall });
    if (r.cap === "account_paused") throw new ApiError("topic_paused", "account is paused");
    throw new ApiError("spend_cap_exceeded", `spend cap reached: ${r.cap}`, { cap: r.cap, remaining_usd_micros: r.remaining });
  }
}

async function ownedTopics(env: Env, accountId: string, topics: string[]): Promise<Set<string>> {
  if (!topics.length) return new Set();
  const { results } = await env.DB.prepare(`SELECT name FROM topics WHERE owner_account_id = ? AND name IN (${topics.map(() => "?").join(",")})`)
    .bind(accountId, ...topics).all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

export function registerKeyRoutes(app: Hono<Vars>, principal: PrincipalFn) {
  /** Upload (or replace) wrapped keys for topics the caller owns. */
  app.put("/v1/keys", async (c) => {
    const p = await principal(c);
    const id = requireAdmin(p);
    const body = (await c.req.json().catch(() => ({}))) as { keys?: unknown };
    if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > MAX_KEYS_PER_REQUEST) {
      throw new ApiError("bad_request", `keys must be an array of 1-${MAX_KEYS_PER_REQUEST} wrapped keys`);
    }
    const bad = body.keys.findIndex((k) => !isWrappedKey(k));
    if (bad >= 0) throw new ApiError("bad_request", `keys[${bad}] is not a wrapped key (spec §5.1)`);
    const keys = body.keys as WrappedKey[];
    const topics = [...new Set(keys.map((k) => k.topic))];
    const owned = await ownedTopics(c.env, id, topics);
    const notOwned = topics.find((t) => !owned.has(t));
    if (notOwned) throw new ApiError("forbidden", `${notOwned} is not a topic you own (create it with PUT /v1/topics first)`);
    for (const t of topics) {
      const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM topic_keys WHERE topic = ?").bind(t).first<{ n: number }>();
      const adding = keys.filter((k) => k.topic === t).length;
      if ((existing?.n ?? 0) + adding > MAX_KEYS_PER_TOPIC) throw new ApiError("bad_request", `${t} would have more than ${MAX_KEYS_PER_TOPIC} wrapped keys; delete old ones first`);
    }
    await meter(c.env, id, p, "put");
    const now = Date.now();
    await c.env.DB.batch(keys.map((k) => c.env.DB.prepare(
      "INSERT INTO topic_keys (topic, kid, device_id, account_id, wrapped, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (topic, kid, device_id) DO UPDATE SET wrapped = excluded.wrapped, created_at = excluded.created_at",
    ).bind(k.topic, k.kid, k.to, id, JSON.stringify(k), now)));
    await audit(c.env, id, actor(p), "keys.put", { count: keys.length, topics });
    return c.json({ stored: keys.length });
  });

  /**
   * A device gets the keys addressed to it; an admin gets every key for the topics it owns.
   * `?topic=` narrows either to one topic.
   */
  app.get("/v1/keys", async (c) => {
    const p = await principal(c);
    const topic = c.req.query("topic");
    if (topic !== undefined && !isTopic(topic)) throw new ApiError("invalid_topic");
    let rows: { wrapped: string; created_at: number }[];
    if (p.kind === "device") {
      const id = requireAccount(p);
      await meter(c.env, id, p, "get");
      const q = topic
        ? c.env.DB.prepare("SELECT wrapped, created_at FROM topic_keys WHERE device_id = ? AND topic = ? ORDER BY created_at").bind(p.deviceId, topic)
        : c.env.DB.prepare("SELECT wrapped, created_at FROM topic_keys WHERE device_id = ? ORDER BY created_at LIMIT 1000").bind(p.deviceId);
      rows = (await q.all<{ wrapped: string; created_at: number }>()).results;
    } else {
      const id = requireAdmin(p);
      await meter(c.env, id, p, "get");
      const q = topic
        ? c.env.DB.prepare("SELECT k.wrapped, k.created_at FROM topic_keys k JOIN topics t ON t.name = k.topic WHERE t.owner_account_id = ? AND k.topic = ? ORDER BY k.created_at").bind(id, topic)
        : c.env.DB.prepare("SELECT k.wrapped, k.created_at FROM topic_keys k JOIN topics t ON t.name = k.topic WHERE t.owner_account_id = ? ORDER BY k.created_at LIMIT 1000").bind(id);
      rows = (await q.all<{ wrapped: string; created_at: number }>()).results;
    }
    return c.json({ keys: rows.map((r) => ({ ...(JSON.parse(r.wrapped) as WrappedKey), created_at: r.created_at })) });
  });

  /** Delete wrapped keys: one topic, optionally one kid and/or one device. */
  app.delete("/v1/keys", async (c) => {
    const p = await principal(c);
    const id = requireAdmin(p);
    const topic = c.req.query("topic");
    const kid = c.req.query("kid");
    const device = c.req.query("device");
    if (!topic || !isTopic(topic)) throw new ApiError("invalid_topic", "topic is required");
    if (!(await ownedTopics(c.env, id, [topic])).has(topic)) throw new ApiError("not_found");
    const where = ["topic = ?"];
    const args: string[] = [topic];
    if (kid) { where.push("kid = ?"); args.push(kid); }
    if (device) { where.push("device_id = ?"); args.push(device); }
    const r = await c.env.DB.prepare(`DELETE FROM topic_keys WHERE ${where.join(" AND ")}`).bind(...args).run();
    await audit(c.env, id, actor(p), "keys.delete", { topic, kid, device, deleted: r.meta.changes });
    return c.json({ deleted: r.meta.changes });
  });
}
