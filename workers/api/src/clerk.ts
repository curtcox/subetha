// Clerk session JWT verification (RS256 via JWKS) using WebCrypto.
import { base64urlDecode, utf8 } from "@subetha/sdk/protocol";
import { b64urlJson } from "./crypto.ts";
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

export interface ClerkClaims { sub: string; iss: string; exp: number; nbf?: number; azp?: string; org_id?: string; email?: string }

/** Returns verified claims, or null if the token is not a valid Clerk session for this instance. */
export async function verifyClerkJwt(token: string, env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<ClerkClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson<{ alg: string; kid: string }>(parts[0]!);
    if (header.alg !== "RS256") return null;
    const jwk = (await getJwks(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64urlDecode(parts[2]!) as BufferSource, utf8.encode(`${parts[0]}.${parts[1]}`) as BufferSource);
    if (!ok) return null;
    const claims = b64urlJson<ClerkClaims>(parts[1]!);
    if (env.CLERK_ISSUER && claims.iss !== env.CLERK_ISSUER) return null;
    if (typeof claims.exp !== "number" || claims.exp < nowSec - 5) return null;
    if (claims.nbf && claims.nbf > nowSec + 5) return null;
    if (env.CLERK_AUTHORIZED_PARTIES && claims.azp && !env.CLERK_AUTHORIZED_PARTIES.split(",").includes(claims.azp)) return null;
    return claims;
  } catch {
    return null;
  }
}
