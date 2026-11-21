// OAuth access tokens for MCP clients and other OAuth apps (PLAN §9: OAuth 2.1 with Clerk as the
// authorization server). The relay is the resource server: /.well-known/oauth-protected-resource
// points clients at Clerk, they run the authorization-code + PKCE flow there, and present the
// access token here. Two token forms are accepted:
//
//  * JWT access tokens (RFC 9068), verified with Clerk's JWKS like session tokens.
//  * Opaque access tokens, checked by RFC 7662 introspection at OAUTH_INTROSPECTION_URL (default
//    `${CLERK_ISSUER}/oauth/token_info`) with OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET.
//
// Either way the token is bound to this resource when it names an audience, and it never gets
// more than publish + subscribe on the user's account, under a per-client daily spend cap
// (accounts.oauth_daily_cap_micros; default $1, 0 turns OAuth access off). Managing the account
// (tokens, endpoints, billing) still needs a session or an admin API token.
import { isOAuthAccessToken, type ClerkClaims } from "./clerk.ts";
import { sha256Hex } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import type { Env, Principal } from "./types.ts";

export const DEFAULT_OAUTH_DAILY_CAP_MICROS = 1_000_000;
export const OAUTH_SCOPES = ["publish", "subscribe"];

export interface OAuthToken {
  sub: string;
  client_id: string;
  aud?: string | string[];
  exp?: number;
}

/**
 * Resource identifiers this server answers to (RFC 8707 / MCP): the MCP endpoint and the API
 * origin, for BASE_URL and for the origin the request arrived on (mcp.subetha.org routes here too).
 */
export function resourceIds(env: Env, requestOrigin?: string): string[] {
  const origins = [...new Set([env.BASE_URL.replace(/\/+$/, ""), ...(requestOrigin ? [requestOrigin] : [])])];
  return origins.flatMap((o) => [`${o}/mcp`, o, `${o}/`]);
}

/** A token that names URL audiences must name this resource; non-URL audiences (client ids) are ignored. */
export function audienceOk(env: Env, aud: string | string[] | undefined, requestOrigin?: string): boolean {
  const list = (Array.isArray(aud) ? aud : aud ? [aud] : []).filter((a) => /^https?:\/\//.test(a));
  if (!list.length) return true;
  const ours = resourceIds(env, requestOrigin);
  return list.some((a) => ours.includes(a));
}

export function fromJwt(claims: ClerkClaims): OAuthToken | null {
  if (!isOAuthAccessToken(claims)) return null;
  return { sub: claims.sub, client_id: claims.client_id ?? claims.azp ?? "unknown", aud: claims.aud, exp: claims.exp };
}

export function introspectionConfigured(env: Env): boolean {
  return !!((env.OAUTH_INTROSPECTION_URL || env.CLERK_ISSUER) && env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET);
}

/** RFC 7662 introspection of an opaque access token, cached briefly. Null when inactive. */
export async function introspect(env: Env, token: string, nowSec = Math.floor(Date.now() / 1000)): Promise<OAuthToken | null> {
  const key = `oat:${await sha256Hex(token)}`;
  const cached = await env.CACHE.get<OAuthToken | { inactive: true }>(key, "json");
  if (cached) return "inactive" in cached || (cached.exp !== undefined && cached.exp <= nowSec) ? null : cached;
  const url = env.OAUTH_INTROSPECTION_URL || `${env.CLERK_ISSUER!.replace(/\/+$/, "")}/oauth/token_info`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`)}` },
    body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
  });
  if (!r.ok) throw new ApiError("provider_unavailable", `token introspection failed (HTTP ${r.status})`);
  const j = (await r.json()) as { active?: boolean; sub?: string; client_id?: string; aud?: string | string[]; exp?: number; token_type?: string };
  const active = j.active === true && typeof j.sub === "string" && (j.exp === undefined || j.exp > nowSec) && (!j.token_type || /access_token|bearer/i.test(j.token_type));
  const result: OAuthToken | null = active ? { sub: j.sub!, client_id: j.client_id ?? "unknown", aud: j.aud, exp: j.exp } : null;
  // A minute (KV's minimum), so a revoked token stops working soon; expiry is rechecked on read.
  await env.CACHE.put(key, JSON.stringify(result ?? { inactive: true }), { expirationTtl: 60 });
  return result;
}

/** The restricted principal for an OAuth access token. */
export async function oauthPrincipal(env: Env, t: OAuthToken, requestOrigin?: string): Promise<Principal> {
  if (!audienceOk(env, t.aud, requestOrigin)) throw new ApiError("unauthorized", "access token was issued for another resource");
  const row = await env.DB.prepare("SELECT id, oauth_daily_cap_micros FROM accounts WHERE clerk_id = ?").bind(t.sub).first<{ id: string; oauth_daily_cap_micros: number | null }>();
  if (!row) throw new ApiError("not_found", "no SubEtha account for this user yet: sign in at the console first");
  const cap = row.oauth_daily_cap_micros ?? DEFAULT_OAUTH_DAILY_CAP_MICROS;
  if (cap <= 0) throw new ApiError("forbidden", "OAuth access is turned off for this account");
  const client = t.client_id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return { kind: "token", accountId: row.id, tokenId: `oauth_${client}`, scopes: OAUTH_SCOPES, caps: { daily: cap, total: null }, transports: null };
}
