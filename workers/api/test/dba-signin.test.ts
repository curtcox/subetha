// Sign in with devicebasedauth.org (dba-signin.ts, PLAN D5), against the stand-in issuer in test/dba.ts.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signJws } from "../src/vendor/devicebasedauth/jose.js";
import { DBA_ISSUER, dbaDevice, dbaFetch, dbaSigner, linkDba } from "./dba.ts";
import { auth, BASE, bootstrap } from "./helpers.ts";

const E = env as unknown as { DB: D1Database; CACHE: KVNamespace };
const discovery = { issuer: DBA_ISSUER, authorization_endpoint: `${DBA_ISSUER}/oauth/authorize`, token_endpoint: `${DBA_ISSUER}/oauth/token`, jwks_uri: `${DBA_ISSUER}/.well-known/jwks.json` };

async function idToken(nonce: string, acct: string, aud = "subetha.us") {
  const now = Math.floor(Date.now() / 1000);
  return signJws({ typ: "JWT", kid: "dba-test" }, { iss: DBA_ISSUER, sub: acct, acct, aud, nonce, iat: now, exp: now + 300 }, (await dbaSigner()).key);
}
async function start() {
  await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/.well-known/openid-configuration`, JSON.stringify(discovery));
  const r = await SELF.fetch(`${BASE}/v1/dba/signin/start`, { method: "POST" });
  expect(r.status).toBe(200);
  const url = new URL(((await r.json()) as { url: string }).url);
  expect(url.searchParams.get("client_id")).toBe("subetha.us");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const state = url.searchParams.get("state")!;
  const saved = await E.DB.prepare("SELECT nonce FROM dba_signin_states WHERE state = ?").bind(state).first<{ nonce: string }>();
  return { state, nonce: saved!.nonce };
}
type Session = { token: string; account_id: string; dba_account: string; created: boolean; expires_at: number };
async function signIn(acct: string, aud?: string): Promise<Response> {
  const s = await start();
  await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/oauth/token`, JSON.stringify({ id_token: await idToken(s.nonce, acct, aud) }));
  return SELF.fetch(`${BASE}/v1/dba/signin/finish`, { method: "POST", body: JSON.stringify({ code: "c0de", state: s.state }) });
}

describe("signing in with devicebasedauth.org", () => {
  it("creates a linked account on first sign-in and returns to it after", async () => {
    const r = await signIn("acct_signin1");
    expect(r.status).toBe(200);
    const first = (await r.json()) as Session;
    expect(first).toMatchObject({ dba_account: "acct_signin1", created: true });
    expect(first.expires_at).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // The session manages the account: no handle yet, then one is set.
    const me = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(first.token) })).json()) as { id: string; handle: string | null };
    expect(me).toMatchObject({ id: first.account_id, handle: null });
    expect((await SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(first.token), body: JSON.stringify({ handle: "signedin1" }) })).status).toBe(200);
    const link = (await (await SELF.fetch(`${BASE}/v1/dba/link`, { headers: auth(first.token) })).json()) as { linked: boolean; dba_account: string };
    expect(link).toMatchObject({ linked: true, dba_account: "acct_signin1" });

    // The same DBA account's devices are this account's devices: past authentication and grants,
    // the new account's empty balance is what stops this publish.
    const device = await dbaDevice("acct_signin1");
    expect((await dbaFetch(device, "/@signedin1/x", { method: "POST", body: "hi" })).status).toBe(402);

    const again = (await (await signIn("acct_signin1")).json()) as Session;
    expect(again).toMatchObject({ account_id: first.account_id, created: false });
    expect(again.token).not.toBe(first.token);
  });

  it("signs in to the account the DBA account is already linked to", async () => {
    const a = await bootstrap("signinlinked", 1);
    await linkDba(a.account_id, "acct_signin2");
    const s = (await (await signIn("acct_signin2")).json()) as Session;
    expect(s).toMatchObject({ account_id: a.account_id, created: false });
  });

  it("uses each attempt once and refuses a wrong nonce or audience", async () => {
    const s = await start();
    await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/oauth/token`, JSON.stringify({ id_token: await idToken(s.nonce, "acct_signin3") }));
    const finish = () => SELF.fetch(`${BASE}/v1/dba/signin/finish`, { method: "POST", body: JSON.stringify({ code: "c0de", state: s.state }) });
    expect((await finish()).status).toBe(200);
    expect((await finish()).status).toBe(400);
    expect((await signIn("acct_signin4", "cronly.org")).status).toBe(401);
    const bad = await start();
    await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/oauth/token`, JSON.stringify({ id_token: await idToken("not-the-nonce", "acct_signin4") }));
    expect((await SELF.fetch(`${BASE}/v1/dba/signin/finish`, { method: "POST", body: JSON.stringify({ code: "c0de", state: bad.state }) })).status).toBe(401);
    expect(await E.DB.prepare("SELECT 1 FROM dba_links WHERE dba_account = 'acct_signin4'").first()).toBeNull();
  });

  it("sends the callback to the console's sign-in, not to linking", async () => {
    const s = await start();
    const r = await SELF.fetch(`${BASE}/auth/dba/callback?code=abc&state=${s.state}`, { redirect: "manual" });
    expect(r.headers.get("location")).toBe(`/console/#dba-signin=1&code=abc&state=${s.state}`);
  });
});
