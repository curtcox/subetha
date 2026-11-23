// Request authentication: API tokens, Clerk session JWTs, anonymous (PLAN §9).
import { TRANSPORTS, type Transport } from "@subetha/sdk/protocol";
import { verifyClerkJwt } from "./clerk.ts";
import { fromJwt, introspect, introspectionConfigured, oauthPrincipal } from "./oauth.ts";
import { authenticateDevice } from "./devices.ts";
import { randomBase32, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import { ipAllowed } from "./ip.ts";
import type { Caller, Env, Principal } from "./types.ts";

export const TOKEN_RE = /^se_([a-z2-7]{16})_([a-z2-7]{32})$/;

export interface TokenRow {
  id: string;
  account_id: string;
  secret_hash: string;
  name: string;
  scopes: string;
  transports: string | null;
  daily_cap_micros: number | null;
  total_cap_micros: number | null;
  origins: string | null;
  ips?: string | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export async function newTokenSecret(): Promise<{ id: string; token: string; hash: string }> {
  const id = randomBase32(10);
  const secret = randomBase32(20);
  return { id, token: `se_${id}_${secret}`, hash: await sha256Hex(secret) };
}

/** Extracts a bearer credential: Authorization header (Bearer or Basic), or ntfy's ?auth= parameter. */
export function extractCredential(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h) {
    const [scheme, value] = h.split(/\s+/, 2);
    if (scheme?.toLowerCase() === "bearer" && value) return value;
    if (scheme?.toLowerCase() === "basic" && value) {
      try {
        const decoded = atob(value);
        const pw = decoded.slice(decoded.indexOf(":") + 1);
        return pw || null;
      } catch {
        return null;
      }
    }
  }
  const auth = new URL(req.url).searchParams.get("auth");
  if (auth) {
    try {
      const decoded = atob(auth.replace(/-/g, "+").replace(/_/g, "/"));
      return extractCredential(new Request("http://x/", { headers: { authorization: decoded } }));
    } catch {
      return null;
    }
  }
  return null;
}

async function loadToken(env: Env, id: string): Promise<TokenRow | null> {
  const cacheKey = `tok:${id}`;
  const cached = await env.CACHE.get<TokenRow>(cacheKey, "json");
  if (cached) return cached;
  const row = await env.DB.prepare("SELECT * FROM tokens WHERE id = ?").bind(id).first<TokenRow>();
  if (row) await env.CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 60 });
  return row;
}

export async function invalidateToken(env: Env, id: string) {
  await env.CACHE.delete(`tok:${id}`);
}

export async function authenticate(req: Request, env: Env): Promise<Principal> {
  const device = await authenticateDevice(req, env);
  if (device) return device;
  const cred = extractCredential(req);
  if (!cred) {
    // An Authorization header we can't parse is an error, not an anonymous request.
    if (req.headers.get("authorization")) throw new ApiError("unauthorized", "unsupported Authorization scheme (use Bearer or Basic)");
    return { kind: "anonymous" };
  }
  const m = TOKEN_RE.exec(cred);
  if (m) {
    const row = await loadToken(env, m[1]!);
    if (!row || row.revoked_at) throw new ApiError("unauthorized", "unknown or revoked token");
    if (!timingSafeEqual(row.secret_hash, await sha256Hex(m[2]!))) throw new ApiError("unauthorized", "unknown or revoked token");
    if (row.expires_at && row.expires_at < Date.now()) throw new ApiError("unauthorized", "token expired");
    if (row.origins) {
      const origins = JSON.parse(row.origins) as string[];
      const origin = req.headers.get("origin");
      if (!origin || !origins.includes(origin)) throw new ApiError("forbidden", "token not valid for this origin");
    }
    if (row.ips && !ipAllowed(req.headers.get("cf-connecting-ip"), JSON.parse(row.ips) as string[])) {
      throw new ApiError("forbidden", "token not valid from this IP address");
    }
    return {
      kind: "token",
      accountId: row.account_id,
      tokenId: row.id,
      scopes: JSON.parse(row.scopes),
      caps: { daily: row.daily_cap_micros, total: row.total_cap_micros },
      transports: row.transports ? (JSON.parse(row.transports) as Transport[]) : null,
    };
  }
  if (cred.startsWith("eyJ")) {
    const claims = await verifyClerkJwt(cred, env);
    if (!claims) throw new ApiError("unauthorized", "invalid session");
    const oauth = fromJwt(claims);
    if (oauth) return await oauthPrincipal(env, oauth, new URL(req.url).origin);
    const clerkId = claims.org_id ?? claims.sub;
    const row = await env.DB.prepare("SELECT id FROM accounts WHERE clerk_id = ?").bind(clerkId).first<{ id: string }>();
    return { kind: "user", accountId: row?.id ?? null, clerkId };
  }
  // Anything else may be an opaque OAuth access token from the authorization server.
  if (introspectionConfigured(env) && /^[\x21-\x7e]{16,4096}$/.test(cred)) {
    const t = await introspect(env, cred);
    if (!t) throw new ApiError("unauthorized", "invalid or expired access token");
    return await oauthPrincipal(env, t, new URL(req.url).origin);
  }
  throw new ApiError("unauthorized", "unrecognized credential");
}

/** Scope grammar: "<action>:<pattern>" where action is publish|subscribe|admin and pattern is "*", an exact topic, or "@handle/*". */
export function scopeAllows(scopes: string[], action: "publish" | "subscribe" | "admin", topic?: string): boolean {
  for (const s of scopes) {
    if (s === "*" || s === "admin") return true;
    const i = s.indexOf(":");
    const a = i < 0 ? s : s.slice(0, i);
    const pat = i < 0 ? "*" : s.slice(i + 1);
    if (a !== action) continue;
    if (!topic || pat === "*") return true;
    if (pat === topic) return true;
    if (pat.endsWith("/*") && topic.startsWith(pat.slice(0, -1))) return true;
  }
  return false;
}

export function validateScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new ApiError("bad_request", "scopes must be a non-empty array");
  for (const s of scopes) {
    if (typeof s !== "string" || !/^(\*|admin|(publish|subscribe)(:(\*|@[a-z0-9-]+\/(\*|[A-Za-z0-9_-]+)|t_[a-z2-7]{26}))?)$/.test(s)) {
      throw new ApiError("bad_request", `invalid scope: ${String(s)}`);
    }
  }
  return scopes as string[];
}

export function validateTransports(t: unknown): Transport[] | null {
  if (t === undefined || t === null) return null;
  if (!Array.isArray(t) || !t.every((x) => (TRANSPORTS as readonly string[]).includes(x))) throw new ApiError("bad_request", "invalid transports");
  return t as Transport[];
}

export function callerOf(p: Principal): Caller {
  switch (p.kind) {
    case "anonymous": return { accountId: null, tokenId: null, deviceId: null, caps: { daily: null, total: null }, transports: null };
    case "token": return { accountId: p.accountId, tokenId: p.tokenId, deviceId: null, caps: p.caps, transports: p.transports };
    case "user": return { accountId: p.accountId, tokenId: null, deviceId: null, caps: { daily: null, total: null }, transports: null };
    case "device": return { accountId: p.accountId, tokenId: null, deviceId: p.deviceId, caps: { daily: null, total: null }, transports: p.transports, denyTransports: p.denyTransports };
  }
}

export function requireAccount(p: Principal): string {
  if (p.kind === "anonymous") throw new ApiError("unauthorized");
  if (!p.accountId) throw new ApiError("not_found", "no account yet: POST /v1/account first");
  return p.accountId;
}

export function requireAdmin(p: Principal): string {
  const id = requireAccount(p);
  if (p.kind === "device") throw new ApiError("forbidden", "devices can publish and subscribe but not manage the account");
  if (p.kind === "token" && !scopeAllows(p.scopes, "admin")) throw new ApiError("forbidden", "token lacks admin scope");
  return id;
}
