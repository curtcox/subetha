// Account directory (D1) helpers.
import { HANDLE_RE, ulid } from "@subetha/sdk/protocol";
import { ApiError } from "./errors.ts";
import type { Env, TopicMeta, TopicPolicy } from "./types.ts";

export interface AccountRow { id: string; handle: string | null; clerk_id: string | null; email: string | null; topups_12mo_micros: number; daily_cap_micros: number | null; oauth_daily_cap_micros?: number | null; telephony_countries?: string | null; paused: number; created_at: number }

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

const TRANSPORT_LIST = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
const NUM = (v: unknown) => v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const BOOL = (v: unknown) => v === undefined || typeof v === "boolean";
const STRS = TRANSPORT_LIST;

export function validatePolicy(p: unknown): TopicPolicy {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new ApiError("bad_request", "policy must be an object");
  const x = p as Record<string, unknown>;
  const checks: [string, (v: unknown) => boolean][] = [
    ["public_publish", BOOL], ["public_read", BOOL], ["require_signature", BOOL], ["paused", BOOL],
    ["anon_rate_per_min", NUM], ["anon_daily_cap_micros", NUM], ["max_cost_per_message_micros", NUM], ["daily_cap_micros", NUM], ["retention_s", NUM],
    ["allowed_publishers", STRS], ["email_senders", STRS], ["allowed_readers", STRS], ["allow_transports", TRANSPORT_LIST], ["deny_transports", TRANSPORT_LIST],
    ["min_priority", (v) => v === undefined || (typeof v === "object" && v !== null)],
    ["quiet_hours", (v) => v === undefined || (typeof v === "object" && v !== null && /^\d\d:\d\d$/.test((v as { start: string }).start) && /^\d\d:\d\d$/.test((v as { end: string }).end))],
  ];
  for (const [k, ok] of checks) if (!ok(x[k])) throw new ApiError("bad_request", `invalid policy field: ${k}`);
  const known = new Set(checks.map(([k]) => k));
  for (const k of Object.keys(x)) if (!known.has(k)) throw new ApiError("bad_request", `unknown policy field: ${k}`);
  return x as TopicPolicy;
}
