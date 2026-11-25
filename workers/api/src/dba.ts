// devicebasedauth.org ("DBA", PLAN §9, open question 1): devices enroll at devicebasedauth.org and
// hold device-bound credentials for the audience subetha.us; subetha verifies them offline (issuer
// signature, revocation status list, DPoP proof of the device's key) with the vendored
// @devicebasedauth/verify. A subetha account links one DBA account through OpenID Connect; a DBA
// credential of that account then acts as one of its devices.
//
//   Authorization: DBA <credential>   + DPoP: <proof>       a device (publish/subscribe per grant)
//   Authorization: Bearer <dba-access+jwt>                 the same, from a short-lived access token
//
// Grants name actions subetha:publish and subetha:subscribe, with topics as resources ("@alice/*",
// "@alice/doorbell"); subetha:session is for signing in. Devices never manage the account, and
// linking (which decides whose devices act for the account) needs the account's admin, like
// enrolling a device did.
import type { Context, Hono } from "hono";
import { audit } from "./accounts.ts";
import { actorOf, requireAdmin } from "./auth.ts";
import { accountStub } from "./durable/account.ts";
import { ApiError } from "./errors.ts";
import type { Env, Principal } from "./types.ts";
import { createOidcClient, createSiteAuth, type SiteAuth, type SiteAuthResult } from "./vendor/devicebasedauth/site.js";

type Vars = { Bindings: Env; Variables: { principal: Principal } };
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

export const DBA_AUDIENCE = "subetha.us";
export const DBA_NAMESPACE = "subetha";
export const DBA_ACTIONS = ["publish", "subscribe"] as const;
export type DbaAction = (typeof DBA_ACTIONS)[number];
const DEFAULT_ISSUER = "https://devicebasedauth.org";
const LINK_TTL_MS = 10 * 60_000;
const MAX_PENDING_LINKS = 10;
// A DPoP proof is accepted for 60 s either side of now (plus clock skew); remember it for longer.
const PROOF_REPLAY_MS = 4 * 60_000;
const LINK_CACHE_S = 60;

/** What a DBA credential lets its device do here, carried on the device principal. */
export interface DbaGrant {
  dbaAccount: string;
  credentialId: string;
  /** The credential's revocation status-list entry. */
  status: { uri: string; idx: number };
  allows(action: DbaAction, topic?: string): boolean;
}

export const dbaIssuer = (env: Env) => (env.DBA_ISSUER || DEFAULT_ISSUER).replace(/\/$/, "");

/**
 * Fetch for the verifier and the OIDC client. In local development and tests, DBA_JWKS stands in
 * for the issuer's JWKS and CACHE keys "dba-fixture:<url>" for its other documents, the way
 * CLERK_JWKS stands in for Clerk's.
 */
function dbaFetch(env: Env): (input: string, init?: RequestInit) => Promise<Response> {
  if (env.ENVIRONMENT !== "local" || !env.DBA_JWKS) return (input, init) => fetch(input, init);
  return async (input) => {
    if (input === `${dbaIssuer(env)}/.well-known/jwks.json`) return new Response(env.DBA_JWKS, { headers: { "content-type": "application/json" } });
    const body = await env.CACHE.get(`dba-fixture:${input}`);
    return body === null ? new Response("not found", { status: 404 }) : new Response(body);
  };
}

// One verifier per isolate keeps the issuer's keys and status lists cached between requests.
let site: { key: string; auth: SiteAuth } | null = null;
function siteAuth(env: Env): SiteAuth {
  const key = `${dbaIssuer(env)}|${env.DBA_STATUS_TTL ?? ""}|${env.ENVIRONMENT}`;
  if (site?.key !== key) {
    const statusTtl = env.DBA_STATUS_TTL !== undefined ? Number(env.DBA_STATUS_TTL) : undefined;
    site = {
      key,
      auth: createSiteAuth({
        audience: DBA_AUDIENCE, namespace: DBA_NAMESPACE, scopes: [...DBA_ACTIONS],
        // The subetha account is looked up after verification (it needs env); replay is checked in
        // the account's Durable Object, which, unlike this isolate's memory, every request shares.
        linkedUser: async (dbaAccount) => dbaAccount,
        issuer: dbaIssuer(env), fetch: dbaFetch(env), replay: false,
        ...(statusTtl !== undefined && Number.isFinite(statusTtl) ? { statusTtl } : {}),
      }),
    };
  }
  return site.auth;
}

/** True when the request presents a DBA credential (scheme DBA, or a Bearer DBA access token). */
export function hasDbaCredential(req: Request): boolean {
  const h = req.headers.get("authorization");
  if (!h) return false;
  const [scheme, value] = h.split(/\s+/, 2);
  if (scheme?.toLowerCase() === "dba") return true;
  if (scheme?.toLowerCase() !== "bearer" || !value?.startsWith("eyJ")) return false;
  try {
    const header = JSON.parse(atob(value.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))) as { typ?: string };
    return header.typ === "dba-access+jwt";
  } catch {
    return false;
  }
}

/** The subetha account a DBA account is linked to, or null. */
export async function linkedAccount(env: Env, dbaAccount: string): Promise<string | null> {
  const cacheKey = `dba-link:${dbaAccount}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) return cached || null;
  const row = await env.DB.prepare("SELECT account_id FROM dba_links WHERE dba_account = ?").bind(dbaAccount).first<{ account_id: string }>();
  await env.CACHE.put(cacheKey, row?.account_id ?? "", { expirationTtl: LINK_CACHE_S });
  return row?.account_id ?? null;
}

function verificationError(r: Extract<SiteAuthResult, { ok: false }>): ApiError {
  if (r.status === 503) return new ApiError("provider_unavailable", `devicebasedauth.org is unavailable (${r.code}); try again shortly`, { dba_code: r.code });
  return new ApiError("unauthorized", `devicebasedauth.org credential refused: ${r.code}${r.message ? ` (${r.message})` : ""}`, { dba_code: r.code });
}

type DeviceRow = { account_id: string; paused: number; allow_transports: string | null; deny_transports: string | null; revoked_at: number | null };

/**
 * A device principal for a request carrying a DBA credential, or null when it carries none.
 * The device is listed (and can be paused, limited or revoked) like any other, as "dba:<id>".
 */
export async function authenticateDba(req: Request, env: Env): Promise<Principal | null> {
  if (!hasDbaCredential(req)) return null;
  const auth = siteAuth(env);
  const r = await auth.authenticate(req);
  if (!r) return null;
  if (!r.ok) throw verificationError(r);
  const accountId = await linkedAccount(env, r.dbaAccount);
  if (!accountId) {
    throw new ApiError("forbidden", `Link devicebasedauth.org account ${r.dbaAccount} to your subetha account first (console → Devices)`, { reason: "account_not_linked", dba_account: r.dbaAccount });
  }
  if (r.proof && !(await accountStub(env, accountId).claimNonce(`dpop:${r.proof.jkt}:${r.proof.jti}`, PROOF_REPLAY_MS))) {
    throw new ApiError("unauthorized", "replayed DPoP proof", { dba_code: "replayed_proof" });
  }
  const id = `dba:${r.deviceId}`;
  const now = Date.now();
  let row = await env.DB.prepare("SELECT account_id, paused, allow_transports, deny_transports, revoked_at FROM devices WHERE id = ?").bind(id).first<DeviceRow>();
  const name = typeof r.payload.device?.name === "string" ? r.payload.device.name.slice(0, 64) : "";
  if (!row || row.account_id !== accountId) {
    // First use here, or the DBA account was linked to another subetha account since: the device
    // starts fresh in this account, with none of the old account's pause or transport settings.
    await env.DB.prepare("INSERT INTO devices (id, account_id, name, capabilities, created_at, last_seen_at, dba_device, dba_credential) VALUES (?, ?, ?, '[]', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, name = excluded.name, paused = 0, allow_transports = NULL, deny_transports = NULL, revoked_at = NULL, created_at = excluded.created_at, dba_credential = excluded.dba_credential")
      .bind(id, accountId, name, now, now, id, r.credentialId).run();
    await audit(env, accountId, `device:${id}`, "device.enroll", { id, via: "devicebasedauth.org", credential: r.credentialId });
    row = { account_id: accountId, paused: 0, allow_transports: null, deny_transports: null, revoked_at: null };
  } else if (row.revoked_at) {
    // Revoked here: only a credential issued after the revocation brings the device back (the
    // owner approved it again at devicebasedauth.org).
    if (r.payload.iat * 1000 <= row.revoked_at) throw new ApiError("unauthorized", "device revoked; approve a new devicebasedauth.org credential for it to use it again");
    await env.DB.prepare("UPDATE devices SET revoked_at = NULL, paused = 0, dba_credential = ? WHERE id = ?").bind(r.credentialId, id).run();
    await audit(env, accountId, `device:${id}`, "device.enroll", { id, via: "devicebasedauth.org", credential: r.credentialId, reinstated: true });
  } else {
    env.DB.prepare("UPDATE devices SET last_seen_at = ?, dba_credential = ? WHERE id = ?").bind(now, r.credentialId, id).run().catch(() => {});
  }
  if (row.paused) throw new ApiError("topic_paused", "device is paused");
  return {
    kind: "device",
    accountId,
    deviceId: id,
    transports: row.allow_transports ? JSON.parse(row.allow_transports) : null,
    denyTransports: row.deny_transports ? JSON.parse(row.deny_transports) : null,
    dba: { dbaAccount: r.dbaAccount, credentialId: r.credentialId, status: r.payload.status.status_list, allows: (action, topic) => auth.allows(r, action, topic) },
  };
}

/** Throws unless a DBA device's grants allow this action on this topic (other principals pass). */
export function requireDbaGrant(p: Principal, action: DbaAction, topic: string) {
  if (p.kind === "device" && p.dba && !p.dba.allows(action, topic)) {
    throw new ApiError("forbidden", `this devicebasedauth.org credential has no grant for ${DBA_NAMESPACE}:${action} on ${topic}`);
  }
}

/** For a signing key attached by a DBA device: has its credential been revoked at devicebasedauth.org? */
export async function attachedCredentialRevoked(env: Env, uri: string, idx: number): Promise<boolean> {
  return siteAuth(env).verifier.isRevoked({ status: { status_list: { uri, idx } } });
}

function oidcClient(env: Env) {
  return createOidcClient({ clientId: DBA_AUDIENCE, redirectUri: `${env.BASE_URL}/auth/dba/callback`, issuer: dbaIssuer(env), fetch: dbaFetch(env) });
}

async function dropLinkCache(env: Env, dbaAccount: string) {
  await env.CACHE.delete(`dba-link:${dbaAccount}`);
}

export function registerDbaRoutes(app: Hono<Vars>, principal: PrincipalFn) {
  // devicebasedauth.org redirects here after the owner approves; the code moves into the fragment
  // (never sent to a server again) and the signed-in console finishes the link.
  app.get("/auth/dba/callback", (c) => {
    const u = new URL(c.req.url);
    const keep = new URLSearchParams();
    for (const k of ["code", "state", "error", "error_description"]) { const v = u.searchParams.get(k); if (v !== null) keep.set(k, v); }
    return new Response(null, { status: 302, headers: { location: `/console/#dba-callback=1&${keep.toString()}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  });

  app.get("/v1/dba/link", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const row = await c.env.DB.prepare("SELECT dba_account, linked_at FROM dba_links WHERE account_id = ?").bind(accountId).first<{ dba_account: string; linked_at: number }>();
    return c.json({ linked: !!row, dba_account: row?.dba_account ?? null, linked_at: row?.linked_at ?? null, issuer: dbaIssuer(c.env), audience: DBA_AUDIENCE });
  });

  app.post("/v1/dba/link/start", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const now = Date.now();
    await c.env.DB.prepare("DELETE FROM dba_link_states WHERE expires_at < ?").bind(now).run();
    const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM dba_link_states WHERE account_id = ?").bind(accountId).first<{ n: number }>();
    if ((pending?.n ?? 0) >= MAX_PENDING_LINKS) throw new ApiError("rate_limited", "too many link attempts in progress; finish one or wait 10 minutes");
    let begun;
    try { begun = await oidcClient(c.env).begin({ scope: "openid" }); } catch (e) { throw new ApiError("provider_unavailable", `devicebasedauth.org is unavailable: ${(e as Error).message}`); }
    await c.env.DB.prepare("INSERT INTO dba_link_states (state, account_id, nonce, verifier, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(begun.state.state, accountId, begun.state.nonce, begun.state.verifier, now + LINK_TTL_MS).run();
    return c.json({ url: begun.url, expires_in: LINK_TTL_MS / 1000 });
  });

  app.post("/v1/dba/link/finish", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; state?: unknown; error?: unknown };
    if (typeof body.state !== "string" || (typeof body.code !== "string" && typeof body.error !== "string")) throw new ApiError("bad_request", "code and state are required");
    // Single use: the state row is gone whatever happens next.
    const saved = await c.env.DB.prepare("DELETE FROM dba_link_states WHERE state = ? RETURNING account_id, nonce, verifier, expires_at").bind(body.state).first<{ account_id: string; nonce: string; verifier: string; expires_at: number }>();
    if (!saved || saved.account_id !== accountId || saved.expires_at < Date.now()) throw new ApiError("bad_request", "unknown or expired link attempt; start again");
    const params = new URLSearchParams({ state: body.state, ...(typeof body.code === "string" ? { code: body.code } : {}), ...(typeof body.error === "string" ? { error: body.error } : {}) });
    let claims;
    try {
      claims = await oidcClient(c.env).finish(params, { state: body.state, nonce: saved.nonce, verifier: saved.verifier });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "issuer_unavailable") throw new ApiError("provider_unavailable", "devicebasedauth.org is unavailable; try again");
      throw new ApiError("unauthorized", `devicebasedauth.org sign-in failed: ${(e as Error).message}`, { dba_code: code ?? null });
    }
    const dbaAccount = typeof claims.acct === "string" ? claims.acct : claims.sub;
    const existing = await c.env.DB.prepare("SELECT account_id FROM dba_links WHERE dba_account = ?").bind(dbaAccount).first<{ account_id: string }>();
    if (existing && existing.account_id !== accountId) throw new ApiError("conflict", "that devicebasedauth.org account is linked to another subetha account; unlink it there first");
    const previous = await c.env.DB.prepare("SELECT dba_account FROM dba_links WHERE account_id = ?").bind(accountId).first<{ dba_account: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM dba_links WHERE account_id = ?").bind(accountId),
      c.env.DB.prepare("INSERT INTO dba_links (dba_account, account_id, linked_at) VALUES (?, ?, ?)").bind(dbaAccount, accountId, Date.now()),
    ]);
    if (previous) await dropLinkCache(c.env, previous.dba_account);
    await dropLinkCache(c.env, dbaAccount);
    await audit(c.env, accountId, actorOf(p), "dba.link", { dba_account: dbaAccount, replaced: previous?.dba_account ?? null });
    return c.json({ linked: true, dba_account: dbaAccount });
  });

  app.delete("/v1/dba/link", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const row = await c.env.DB.prepare("DELETE FROM dba_links WHERE account_id = ? RETURNING dba_account").bind(accountId).first<{ dba_account: string }>();
    if (!row) throw new ApiError("not_found", "no devicebasedauth.org account is linked");
    await dropLinkCache(c.env, row.dba_account);
    await audit(c.env, accountId, actorOf(p), "dba.unlink", { dba_account: row.dba_account });
    return c.json({ linked: false });
  });
}
