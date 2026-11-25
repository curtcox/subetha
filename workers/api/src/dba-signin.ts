// Sign in with devicebasedauth.org (PLAN D5): the console signs people in through DBA's OpenID
// Connect, with no Clerk. The DBA account names the subetha account through dba_links (the same
// link that makes its devices this account's devices); a DBA account seen for the first time gets
// a new account, linked to it, with no handle yet (PATCH /v1/account sets one).
//
// The console's session is an ordinary API token with the admin scope that expires in 30 days,
// listed under Tokens like any other, so it can be seen and revoked.
import type { Context, Hono } from "hono";
import { audit, createAccount } from "./accounts.ts";
import { newTokenSecret } from "./auth.ts";
import { dropLinkCache, linkedAccount, oidcClient } from "./dba.ts";
import { accountStub } from "./durable/account.ts";
import { ApiError } from "./errors.ts";
import type { Env, Principal } from "./types.ts";

type Vars = { Bindings: Env; Variables: { principal: Principal } };
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

const SIGNIN_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 86_400_000;
// Pending sign-ins are anonymous, so cap them: the per-IP rate limit already applies.
const MAX_PENDING = 10_000;

export function registerDbaSigninRoutes(app: Hono<Vars>, _principal: PrincipalFn) {
  app.post("/v1/dba/signin/start", async (c) => {
    const now = Date.now();
    await c.env.DB.prepare("DELETE FROM dba_signin_states WHERE expires_at < ?").bind(now).run();
    const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM dba_signin_states").first<{ n: number }>();
    if ((pending?.n ?? 0) >= MAX_PENDING) throw new ApiError("rate_limited", "too many sign-ins in progress; try again in a few minutes");
    let begun;
    try { begun = await oidcClient(c.env).begin({ scope: "openid" }); } catch (e) { throw new ApiError("provider_unavailable", `devicebasedauth.org is unavailable: ${(e as Error).message}`); }
    await c.env.DB.prepare("INSERT INTO dba_signin_states (state, nonce, verifier, expires_at) VALUES (?, ?, ?, ?)")
      .bind(begun.state.state, begun.state.nonce, begun.state.verifier, now + SIGNIN_TTL_MS).run();
    return c.json({ url: begun.url, expires_in: SIGNIN_TTL_MS / 1000 });
  });

  app.post("/v1/dba/signin/finish", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; state?: unknown; error?: unknown };
    if (typeof body.state !== "string" || (typeof body.code !== "string" && typeof body.error !== "string")) throw new ApiError("bad_request", "code and state are required");
    // Single use: the state row is gone whatever happens next.
    const saved = await c.env.DB.prepare("DELETE FROM dba_signin_states WHERE state = ? RETURNING nonce, verifier, expires_at").bind(body.state).first<{ nonce: string; verifier: string; expires_at: number }>();
    if (!saved || saved.expires_at < Date.now()) throw new ApiError("bad_request", "unknown or expired sign-in; start again");
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
    const actor = `dba:${dbaAccount}`;
    let accountId = await linkedAccount(c.env, dbaAccount);
    const created = !accountId;
    if (!accountId) {
      const acct = await createAccount(c.env, { handle: null, clerkId: null });
      await accountStub(c.env, acct.id).setAccountId(acct.id);
      // INSERT OR IGNORE: if two first sign-ins race, the second account stays unlinked and unused.
      await c.env.DB.prepare("INSERT OR IGNORE INTO dba_links (dba_account, account_id, linked_at) VALUES (?, ?, ?)").bind(dbaAccount, acct.id, Date.now()).run();
      await dropLinkCache(c.env, dbaAccount);
      accountId = await linkedAccount(c.env, dbaAccount);
      if (!accountId) throw new ApiError("conflict", "sign-in raced another; try again");
      if (accountId === acct.id) {
        await audit(c.env, acct.id, actor, "account.create", { via: "devicebasedauth.org" });
        await audit(c.env, acct.id, actor, "dba.link", { dba_account: dbaAccount, replaced: null });
      }
    }
    const t = await newTokenSecret();
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO tokens (id, account_id, secret_hash, name, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(t.id, accountId, t.hash, "Console sign-in (devicebasedauth.org)", JSON.stringify(["admin"]), now + SESSION_TTL_MS, now).run();
    await audit(c.env, accountId, actor, "account.signin", { via: "devicebasedauth.org", token: t.id });
    return c.json({ token: t.token, expires_at: now + SESSION_TTL_MS, account_id: accountId, dba_account: dbaAccount, created });
  });
}
