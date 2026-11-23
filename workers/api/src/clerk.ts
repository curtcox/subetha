// Clerk session JWT verification (RS256 via JWKS) and Svix webhook verification using WebCrypto.
import { base64urlDecode, utf8 } from "@subetha/sdk/protocol";
import { b64urlJson, timingSafeEqual } from "./crypto.ts";
import type { Env } from "./types.ts";

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { at: number; keys: Jwk[]; src: string } | null = null;

async function getJwks(env: Env): Promise<Jwk[]> {
  if (env.CLERK_JWKS) return (JSON.parse(env.CLERK_JWKS) as { keys: Jwk[] }).keys;
  if (!env.CLERK_JWKS_URL) return [];
  if (jwksCache && jwksCache.src === env.CLERK_JWKS_URL && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const r = await fetch(env.CLERK_JWKS_URL);
  if (!r.ok) throw new Error(`JWKS fetch failed: ${r.status}`);
  const keys = ((await r.json()) as { keys: Jwk[] }).keys;
  jwksCache = { at: Date.now(), keys, src: env.CLERK_JWKS_URL };
  return keys;
}

export interface ClerkClaims {
  sub: string;
  iss: string;
  exp: number;
  nbf?: number;
  azp?: string;
  org_id?: string;
  org_role?: string;
  /** Clerk JWT v2 compact org claim: `{ id, rol }`. */
  o?: { id?: string; rol?: string };
  email?: string;
  /** OAuth access tokens (RFC 9068): the client the token was issued to, its scopes, and audience. */
  client_id?: string;
  scope?: string;
  aud?: string | string[];
  /** JOSE header `typ` (`at+jwt` for OAuth access tokens). */
  typ?: string;
}

/** Extracts organization id and role from Clerk v1 (`org_id`/`org_role`) or v2 (`o.id`/`o.rol`) claims. */
export function orgContext(claims: ClerkClaims): { orgId?: string; orgRole?: string } {
  const orgId = claims.org_id ?? claims.o?.id;
  const orgRole = claims.org_role ?? claims.o?.rol;
  return { ...(orgId ? { orgId } : {}), ...(orgRole ? { orgRole } : {}) };
}

/** Whether a Clerk organization role grants admin rights on the shared org account. */
export function isOrgAdminRole(role: string | undefined): boolean {
  return role === "org:admin" || role === "admin";
}

/** An OAuth access token (for an MCP client or other OAuth app), as opposed to a browser session. */
export const isOAuthAccessToken = (c: ClerkClaims) => c.typ?.toLowerCase() === "at+jwt" || typeof c.client_id === "string";

/** Returns verified claims, or null if the token is not a valid Clerk session for this instance. */
export async function verifyClerkJwt(token: string, env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<ClerkClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson<{ alg: string; kid: string; typ?: string }>(parts[0]!);
    if (header.alg !== "RS256") return null;
    const jwk = (await getJwks(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64urlDecode(parts[2]!) as BufferSource, utf8.encode(`${parts[0]}.${parts[1]}`) as BufferSource);
    if (!ok) return null;
    const claims: ClerkClaims = { ...b64urlJson<ClerkClaims>(parts[1]!), typ: header.typ };
    if (env.CLERK_ISSUER && claims.iss !== env.CLERK_ISSUER) return null;
    if (typeof claims.exp !== "number" || claims.exp < nowSec - 5) return null;
    if (claims.nbf && claims.nbf > nowSec + 5) return null;
    // azp is the browser origin of a session; OAuth access tokens are bound by audience instead (oauth.ts).
    if (!isOAuthAccessToken(claims) && env.CLERK_AUTHORIZED_PARTIES && claims.azp && !env.CLERK_AUTHORIZED_PARTIES.split(",").includes(claims.azp)) return null;
    return claims;
  } catch {
    return null;
  }
}

function svixSecretBytes(secret: string): Uint8Array {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
}

async function svixMacBase64(secret: string, signedContent: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", svixSecretBytes(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(signedContent) as BufferSource));
  return btoa(String.fromCharCode(...mac));
}

/** Signs a Clerk/Svix webhook payload (`svix-signature` header value: `v1,<base64>`). */
export async function signClerkWebhook(payload: string, secret: string, svixId: string, svixTimestamp: string): Promise<string> {
  return `v1,${await svixMacBase64(secret, `${svixId}.${svixTimestamp}.${payload}`)}`;
}

/** Verifies Clerk/Svix webhook headers (`svix-id`, `svix-timestamp`, `svix-signature`) with 5-minute tolerance. */
export async function verifyClerkWebhook(
  payload: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  let expected: string;
  try {
    expected = await svixMacBase64(secret, `${id}.${timestamp}.${payload}`);
  } catch {
    return false;
  }
  const sigs = signature.split(/\s+/).filter((s) => s.startsWith("v1,")).map((s) => s.slice(3));
  return sigs.some((s) => timingSafeEqual(s, expected));
}
