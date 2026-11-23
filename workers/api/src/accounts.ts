// Account directory (D1) helpers.
import { HANDLE_RE, TRANSPORTS, ulid, type Transport } from "@subetha/sdk/protocol";
import { tierFor, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { topicStub } from "./durable/topic.ts";
import { ApiError } from "./errors.ts";
import type { Env, TopicMeta, TopicPolicy } from "./types.ts";

const PRICES = prices as unknown as PriceTable;
const YEAR_MS = 365 * 86_400_000;

export interface AccountRow { id: string; handle: string | null; clerk_id: string | null; email: string | null; topups_12mo_micros: number; daily_cap_micros: number | null; monthly_cap_micros?: number | null; allow_transports?: string | null; deny_transports?: string | null; oauth_daily_cap_micros?: number | null; telephony_countries?: string | null; stripe_customer_id?: string | null; auto_recharge?: string | null; paused: number; created_at: number }

export function accountTransportsOf(acct: AccountRow | null): { allow: Transport[] | null; deny: Transport[] | null } {
  return {
    allow: acct?.allow_transports ? (JSON.parse(acct.allow_transports) as Transport[]) : null,
    deny: acct?.deny_transports ? (JSON.parse(acct.deny_transports) as Transport[]) : null,
  };
}

/** Propagates the account's transport allow/deny lists to all of its topics' Durable Objects. */
export async function syncAccountTopics(env: Env, accountId: string, allow: Transport[] | null, deny: Transport[] | null) {
  const { results } = await env.DB.prepare("SELECT name FROM topics WHERE owner_account_id = ?").bind(accountId).all<{ name: string }>();
  for (const r of results) await topicStub(env, r.name).setAccountTransports(allow, deny);
}

/** Propagates the account's pricing tier to all of its topics' Durable Objects (PLAN §8, rule 7). */
export async function syncAccountTier(env: Env, accountId: string, tier: string) {
  const { results } = await env.DB.prepare("SELECT name FROM topics WHERE owner_account_id = ?").bind(accountId).all<{ name: string }>();
  for (const r of results) await topicStub(env, r.name).setTier(tier);
}

/** Current volume-discount tier for an account (from cached account row). */
export async function accountTier(env: Env, accountId: string): Promise<string> {
  const acct = await getAccount(env, accountId);
  return tierFor(PRICES, acct?.topups_12mo_micros ?? 0);
}

/**
 * Recomputes rolling 12-month net top-ups from stripe_payments (excluding disputed payments and
 * subtracting refunds), updates accounts.topups_12mo_micros, and propagates any tier change to
 * every topic owned by the account.
 */
export async function recomputeAccountTopups12mo(
  env: Env,
  accountId: string,
  now = Date.now(),
): Promise<{ topups12mo: number; tier: string; tierChanged: boolean }> {
  const prevRow = await env.DB.prepare("SELECT topups_12mo_micros FROM accounts WHERE id = ?").bind(accountId).first<{ topups_12mo_micros: number }>();
  const prev = Number(prevRow?.topups_12mo_micros ?? 0);
  const sumRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(MAX(0, amount_micros - refunded_micros)), 0) AS total
       FROM stripe_payments
      WHERE account_id = ? AND disputed = 0 AND created_at >= ?`,
  ).bind(accountId, now - YEAR_MS).first<{ total: number }>();
  const next = Math.max(0, Number(sumRow?.total ?? 0));
  const prevTier = tierFor(PRICES, prev);
  const nextTier = tierFor(PRICES, next);
  if (next !== prev) {
    await env.DB.prepare("UPDATE accounts SET topups_12mo_micros = ? WHERE id = ?").bind(next, accountId).run();
    await invalidateAccount(env, accountId);
  }
  const tierChanged = nextTier !== prevTier;
  if (tierChanged) {
    await syncAccountTier(env, accountId, nextTier);
    await audit(env, accountId, "system", "account.tier_changed", { from: prevTier, to: nextTier, topups_12mo_micros: next });
  }
  return { topups12mo: next, tier: nextTier, tierChanged };
}

const RESERVED_HANDLES = new Set(["admin", "api", "subetha", "root", "system", "support", "help", "www", "mail", "docs", "console", "status", "billing", "security", "abuse", "ntfy", "mcp", "v1"]);

export async function getAccount(env: Env, id: string): Promise<AccountRow | null> {
  const key = `acct:${id}`;
  const cached = await env.CACHE.get<AccountRow>(key, "json");
  if (cached) return cached;
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
  if (row) await env.CACHE.put(key, JSON.stringify(row), { expirationTtl: 300 });
  return row;
}

export async function invalidateAccount(env: Env, id: string) {
  await env.CACHE.delete(`acct:${id}`);
}

export function validateHandle(h: unknown): string {
  if (typeof h !== "string" || !HANDLE_RE.test(h)) throw new ApiError("bad_request", "handle must match [a-z0-9][a-z0-9-]{0,38} (no trailing dash)");
  if (RESERVED_HANDLES.has(h)) throw new ApiError("conflict", "handle is reserved");
  return h;
}

export async function createAccount(env: Env, opts: { handle: string | null; clerkId: string | null; email?: string | null }): Promise<AccountRow> {
  const id = `acct_${ulid()}`;
  const row: AccountRow = { id, handle: opts.handle, clerk_id: opts.clerkId, email: opts.email ?? null, topups_12mo_micros: 0, daily_cap_micros: null, paused: 0, created_at: Date.now() };
  try {
    await env.DB.prepare("INSERT INTO accounts (id, handle, clerk_id, email, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, row.handle, row.clerk_id, row.email, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError("conflict", "handle or account already exists");
    throw e;
  }
  return row;
}

/** Who may create a topic by publishing to it: the namespace owner, or anyone authenticated for secret topics. */
export async function autoCreateOwnerFor(env: Env, accountId: string | null, topic: string): Promise<string | null> {
  if (!accountId) return null;
  if (topic.startsWith("t_")) return accountId;
  const acct = await getAccount(env, accountId);
  const handle = topic.slice(1, topic.indexOf("/"));
  return acct?.handle === handle ? accountId : null;
}

export async function recordTopic(env: Env, meta: TopicMeta) {
  await env.DB.prepare("INSERT INTO topics (name, owner_account_id, policy, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET policy = excluded.policy")
    .bind(meta.name, meta.owner, JSON.stringify(meta.policy), meta.created_at).run();
}

export async function audit(env: Env, accountId: string, actor: string, action: string, detail?: unknown) {
  await env.DB.prepare("INSERT INTO audit_log (account_id, actor, action, detail, time) VALUES (?, ?, ?, ?, ?)")
    .bind(accountId, actor, action, detail === undefined ? null : JSON.stringify(detail), Date.now()).run();
}

const STRS = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
const TRANSPORT_LIST = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string" && (TRANSPORTS as readonly string[]).includes(x)));
const NUM = (v: unknown) => v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const POS = (v: unknown) => v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 1);
const BOOL = (v: unknown) => v === undefined || typeof v === "boolean";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validMinPriority(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!(TRANSPORTS as readonly string[]).includes(k)) return false;
    if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 1 || val > 5) return false;
  }
  return true;
}

function validQuietHours(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const q = v as { start?: unknown; end?: unknown; tz?: unknown };
  if (typeof q.start !== "string" || !HHMM.test(q.start) || typeof q.end !== "string" || !HHMM.test(q.end)) return false;
  if (q.tz !== undefined) {
    if (typeof q.tz !== "string" || !q.tz || q.tz.length > 64) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: q.tz }); } catch { return false; }
  }
  return true;
}

export function validatePolicy(p: unknown): TopicPolicy {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new ApiError("bad_request", "policy must be an object");
  const x = p as Record<string, unknown>;
  const checks: [string, (v: unknown) => boolean][] = [
    ["public_publish", BOOL], ["public_read", BOOL], ["require_signature", BOOL], ["paused", BOOL],
    ["anon_rate_per_min", NUM], ["anon_daily_cap_micros", NUM], ["rate_per_min", POS], ["burst", POS],
    ["max_cost_per_message_micros", NUM], ["daily_cap_micros", NUM], ["monthly_cap_micros", NUM], ["retention_s", NUM],
    ["allowed_publishers", STRS], ["email_senders", STRS], ["allowed_readers", STRS], ["allow_transports", TRANSPORT_LIST], ["deny_transports", TRANSPORT_LIST],
    ["min_priority", validMinPriority],
    ["quiet_hours", validQuietHours],
  ];
  for (const [k, ok] of checks) if (!ok(x[k])) throw new ApiError("bad_request", `invalid policy field: ${k}`);
  const known = new Set(checks.map(([k]) => k));
  for (const k of Object.keys(x)) if (!known.has(k)) throw new ApiError("bad_request", `unknown policy field: ${k}`);
  return x as TopicPolicy;
}
