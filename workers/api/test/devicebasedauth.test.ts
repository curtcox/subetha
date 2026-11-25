// devicebasedauth.org devices and account linking (dba.ts, PLAN D5), against the stand-in issuer
// in test/dba.ts.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "@subetha/sdk/protocol";
import { SubEtha } from "@subetha/sdk";
import { signJws } from "../src/vendor/devicebasedauth/jose.js";
import { ALL_TOPICS, DBA_ISSUER, dbaDevice, dbaFetch, dbaSigner, enrollDevice, linkDba } from "./dba.ts";
import { auth, BASE, bootstrap } from "./helpers.ts";

const E = env as unknown as { DB: D1Database; CACHE: KVNamespace };
const post = (device: Awaited<ReturnType<typeof dbaDevice>>, topic: string, message: string) => dbaFetch(device, `/${topic}`, { method: "POST", body: message });
const code = async (r: Response) => ((await r.json()) as { error: string; dba_code?: string; reason?: string });

describe("devicebasedauth.org device credentials", () => {
  it("publish and subscribe within their grants, as a listed device that can't manage the account", async () => {
    const a = await bootstrap("dbagrants", 1);
    const device = await dbaDevice(await linkDba(a.account_id), { grants: [{ actions: ["subetha:publish", "subetha:subscribe"], resources: ["@dbagrants/door*"] }], name: "door-pi" });
    expect((await post(device, "@dbagrants/door", "open")).status).toBe(200);
    const other = await post(device, "@dbagrants/garage", "nope");
    expect(other.status).toBe(403);
    expect((await code(other)).error).toBe("forbidden");
    const polled = await dbaFetch(device, "/@dbagrants/door/json?poll=1");
    expect(await polled.text()).toContain('"message":"open"');
    expect((await dbaFetch(device, "/@dbagrants/garage/json?poll=1")).status).toBe(403);
    expect((await dbaFetch(device, "/v1/tokens")).status).toBe(403);

    const { devices } = (await (await SELF.fetch(`${BASE}/v1/devices`, { headers: auth(a.token) })).json()) as { devices: { id: string; name: string }[] };
    expect(devices).toContainEqual(expect.objectContaining({ id: `dba:${device.deviceId}`, name: "door-pi" }));
  });

  it("publish-only grants can't subscribe", async () => {
    const a = await bootstrap("dbapubonly", 1);
    const device = await dbaDevice(await linkDba(a.account_id), { grants: [{ actions: ["subetha:publish"] }] });
    expect((await post(device, "@dbapubonly/x", "hi")).status).toBe(200);
    expect((await dbaFetch(device, "/@dbapubonly/x/json?poll=1")).status).toBe(403);
  });

  it("refuse unlinked accounts, other audiences, missing, replayed or foreign proofs, and revoked credentials", async () => {
    const a = await bootstrap("dbarefuse", 1);
    const unlinked = await dbaDevice("acct_nobodyhere");
    const r = await post(unlinked, "@dbarefuse/x", "hi");
    expect(r.status).toBe(403);
    expect((await code(r)).reason).toBe("account_not_linked");

    const dbaAccount = await linkDba(a.account_id);
    const elsewhere = await dbaDevice(dbaAccount, { aud: ["cronly.org"] });
    expect((await post(elsewhere, "@dbarefuse/x", "hi")).status).toBe(401);

    const device = await dbaDevice(dbaAccount);
    const url = `${BASE}/@dbarefuse/x`;
    expect((await SELF.fetch(url, { method: "POST", body: "hi", headers: { authorization: `DBA ${device.credential}` } })).status).toBe(401);
    const h = await device.headers("POST", url);
    expect((await SELF.fetch(url, { method: "POST", body: "once", headers: h })).status).toBe(200);
    const replay = await SELF.fetch(url, { method: "POST", body: "twice", headers: h });
    expect(replay.status).toBe(401);
    expect((await code(replay)).dba_code).toBe("replayed_proof");
    const wrongUrl = await device.headers("POST", `${BASE}/@dbarefuse/y`);
    expect((await SELF.fetch(url, { method: "POST", body: "moved", headers: wrongUrl })).status).toBe(401);
    const stranger = await dbaDevice(dbaAccount);
    const foreign = { ...(await stranger.headers("POST", url)), authorization: `DBA ${device.credential}` };
    expect((await SELF.fetch(url, { method: "POST", body: "foreign", headers: foreign })).status).toBe(401);

    await device.revoke();
    const revoked = await post(device, "@dbarefuse/x", "after");
    expect(revoked.status).toBe(401);
    expect((await code(revoked)).dba_code).toBe("revoked");
  });

  it("are paused and revoked here like other devices; only a newer credential brings a revoked one back", async () => {
    const a = await bootstrap("dbapause", 1);
    const dbaAccount = await linkDba(a.account_id);
    const device = await dbaDevice(dbaAccount, { deviceId: "dev_pausable1", iat: Math.floor(Date.now() / 1000) - 60 });
    expect((await post(device, "@dbapause/x", "hi")).status).toBe(200);
    const id = encodeURIComponent("dba:dev_pausable1");
    await SELF.fetch(`${BASE}/v1/devices/${id}`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: true }) });
    expect((await post(device, "@dbapause/x", "paused")).status).toBe(403);
    await SELF.fetch(`${BASE}/v1/devices/${id}`, { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ paused: false }) });
    expect((await SELF.fetch(`${BASE}/v1/devices/${id}`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);
    expect((await post(device, "@dbapause/x", "revoked")).status).toBe(401);
    const approvedAgain = await dbaDevice(dbaAccount, { deviceId: "dev_pausable1", iat: Math.floor(Date.now() / 1000) + 1 });
    expect((await post(approvedAgain, "@dbapause/x", "back")).status).toBe(200);
  });

  it("stop working when the account unlinks", async () => {
    const a = await bootstrap("dbaunlink", 1);
    const device = await dbaDevice(await linkDba(a.account_id));
    expect((await post(device, "@dbaunlink/x", "hi")).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/dba/link`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);
    expect((await post(device, "@dbaunlink/x", "gone")).status).toBe(403);
  });
});

describe("signing keys attached by devicebasedauth.org devices", () => {
  it("need grants on every topic", async () => {
    const a = await bootstrap("dbaattach", 1);
    const device = await dbaDevice(await linkDba(a.account_id), { grants: [{ actions: ["subetha:publish", "subetha:subscribe"], resources: ["@dbaattach/*"] }] });
    const key = await generateDeviceKey();
    const { enrollmentProof } = await import("@subetha/sdk");
    const r = await dbaFetch(device, "/v1/devices/dba", { method: "POST", body: JSON.stringify(await enrollmentProof(key)) });
    expect(r.status).toBe(403);
  });

  it("can't be attached with an API token", async () => {
    const a = await bootstrap("dbaattachtok", 1);
    const key = await generateDeviceKey();
    const { enrollmentProof } = await import("@subetha/sdk");
    expect((await SELF.fetch(`${BASE}/v1/devices/dba`, { method: "POST", headers: auth(a.token), body: JSON.stringify(await enrollmentProof(key)) })).status).toBe(401);
  });

  it("sign requests until the devicebasedauth.org credential that attached them is revoked", async () => {
    const a = await bootstrap("dbakeyrevoke", 1);
    const dbaAccount = await linkDba(a.account_id);
    const device = await dbaDevice(dbaAccount, { grants: ALL_TOPICS });
    const key = await generateDeviceKey();
    const { enrollmentProof } = await import("@subetha/sdk");
    expect((await dbaFetch(device, "/v1/devices/dba", { method: "POST", body: JSON.stringify(await enrollmentProof(key)) })).status).toBe(201);
    const signed = new SubEtha({ baseUrl: BASE, fetch: SELF.fetch.bind(SELF) as typeof fetch, deviceKey: key, signRequests: true });
    expect((await signed.publish("@dbakeyrevoke/x", "signed")).message).toBe("signed");
    await device.revoke();
    await expect(signed.publish("@dbakeyrevoke/x", "after")).rejects.toMatchObject({ code: "unauthorized" });
    const row = await E.DB.prepare("SELECT revoked_at FROM devices WHERE id = ?").bind(key.deviceId).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).not.toBeNull();
  });

  it("count as one device with their devicebasedauth.org device for rent", async () => {
    const a = await bootstrap("dbarent", 1);
    expect((await enrollDevice(a.account_id, await generateDeviceKey())).status).toBe(201);
    const n = await E.DB.prepare("SELECT COUNT(DISTINCT COALESCE(dba_device, id)) AS n FROM devices WHERE account_id = ? AND revoked_at IS NULL").bind(a.account_id).first<{ n: number }>();
    const rows = await E.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?").bind(a.account_id).first<{ n: number }>();
    expect(rows?.n).toBe(2);
    expect(n?.n).toBe(1);
  });
});

describe("linking a devicebasedauth.org account", () => {
  const discovery = { issuer: DBA_ISSUER, authorization_endpoint: `${DBA_ISSUER}/oauth/authorize`, token_endpoint: `${DBA_ISSUER}/oauth/token`, jwks_uri: `${DBA_ISSUER}/.well-known/jwks.json` };
  async function idToken(nonce: string, acct: string, aud = "subetha.us") {
    const now = Math.floor(Date.now() / 1000);
    return signJws({ typ: "JWT", kid: "dba-test" }, { iss: DBA_ISSUER, sub: acct, acct, aud, nonce, iat: now, exp: now + 300 }, (await dbaSigner()).key);
  }
  async function start(token: string) {
    await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/.well-known/openid-configuration`, JSON.stringify(discovery));
    const r = await SELF.fetch(`${BASE}/v1/dba/link/start`, { method: "POST", headers: auth(token), body: "{}" });
    expect(r.status).toBe(200);
    const url = new URL(((await r.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`${DBA_ISSUER}/oauth/authorize`);
    expect(url.searchParams.get("client_id")).toBe("subetha.us");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/auth\/dba\/callback$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const saved = await E.DB.prepare("SELECT nonce FROM dba_link_states WHERE state = ?").bind(state).first<{ nonce: string }>();
    return { state, nonce: saved!.nonce };
  }
  const finish = (token: string, state: string) => SELF.fetch(`${BASE}/v1/dba/link/finish`, { method: "POST", headers: auth(token), body: JSON.stringify({ code: "c0de", state }) });

  it("links once per attempt, one DBA account to one subetha account", async () => {
    const a = await bootstrap("dbalink", 1);
    const b = await bootstrap("dbalink2", 1);
    const s = await start(a.token);
    await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/oauth/token`, JSON.stringify({ id_token: await idToken(s.nonce, "acct_linkme1") }));
    const r = await finish(a.token, s.state);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ linked: true, dba_account: "acct_linkme1" });
    expect((await finish(a.token, s.state)).status).toBe(400); // single use
    const link = (await (await SELF.fetch(`${BASE}/v1/dba/link`, { headers: auth(a.token) })).json()) as { linked: boolean; dba_account: string };
    expect(link).toMatchObject({ linked: true, dba_account: "acct_linkme1", audience: "subetha.us" });

    // Another subetha account can't take that DBA account, and can't use a's attempt.
    const sb = await start(b.token);
    await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/oauth/token`, JSON.stringify({ id_token: await idToken(sb.nonce, "acct_linkme1") }));
    expect((await finish(b.token, sb.state)).status).toBe(409);
    const sa = await start(a.token);
    expect((await finish(b.token, sa.state)).status).toBe(400);

    // The linked account's devices work.
    const device = await dbaDevice("acct_linkme1");
    expect((await post(device, "@dbalink/x", "linked")).status).toBe(200);
  });

  it("refuses an ID token with the wrong nonce or audience", async () => {
    const a = await bootstrap("dbalinkbad", 1);
    let s = await start(a.token);
    await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/oauth/token`, JSON.stringify({ id_token: await idToken("not-the-nonce", "acct_badlink1") }));
    expect((await finish(a.token, s.state)).status).toBe(401);
    s = await start(a.token);
    await E.CACHE.put(`dba-fixture:${DBA_ISSUER}/oauth/token`, JSON.stringify({ id_token: await idToken(s.nonce, "acct_badlink1", "cronly.org") }));
    expect((await finish(a.token, s.state)).status).toBe(401);
    expect(((await (await SELF.fetch(`${BASE}/v1/dba/link`, { headers: auth(a.token) })).json()) as { linked: boolean }).linked).toBe(false);
  });

  it("needs the account's admin, not a device", async () => {
    const a = await bootstrap("dbalinkdev", 1);
    const device = await dbaDevice(await linkDba(a.account_id));
    expect((await dbaFetch(device, "/v1/dba/link/start", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await dbaFetch(device, "/v1/dba/link", { method: "DELETE" })).status).toBe(403);
  });

  it("moves the callback's code into the console's URL fragment", async () => {
    const r = await SELF.fetch(`${BASE}/auth/dba/callback?code=abc&state=xyz&junk=1`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/console/#dba-callback=1&code=abc&state=xyz");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
