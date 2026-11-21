import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap, clerkJwt, publish } from "./helpers.ts";

const E = env as unknown as Env;
const rpc = (authz: string | null, method: string, params: Record<string, unknown> = {}) =>
  SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(authz ? { authorization: authz } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

/** A funded account linked to a Clerk user, as if they had signed in to the console. */
async function linked(handle: string, clerkUser: string) {
  const a = await bootstrap(handle, 5);
  await E.DB.prepare("UPDATE accounts SET clerk_id = ? WHERE id = ?").bind(clerkUser, a.account_id).run();
  return a;
}
const accessToken = (sub: string, claims: Record<string, unknown> = {}) => clerkJwt(sub, { typ: "at+jwt", claims: { client_id: "mcp-client-1", scope: "openid profile", ...claims } });

afterEach(() => vi.unstubAllGlobals());

describe("OAuth access tokens (MCP)", () => {
  it("lets an MCP client publish and poll with a JWT access token, but not manage the account", async () => {
    await linked("oauthy", "user_oauthy");
    const at = await accessToken("user_oauthy", { aud: `${BASE}/mcp` });
    const tools = (await (await rpc(`Bearer ${at}`, "tools/call", { name: "publish", arguments: { topic: "@oauthy/inbox", message: "from an agent" } })).json()) as { result: { isError: boolean } };
    expect(tools.result.isError).toBe(false);
    const polled = await SELF.fetch(`${BASE}/@oauthy/inbox/json?poll=1`, { headers: auth(at) });
    expect(await polled.text()).toContain("from an agent");
    expect((await SELF.fetch(`${BASE}/v1/tokens`, { headers: auth(at) })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/billing/checkout`, { method: "POST", headers: auth(at), body: JSON.stringify({ amount_usd: 10 }) })).status).toBe(403);
  });

  it("rejects tokens for another resource with a 401 challenge", async () => {
    await linked("oauthaud", "user_oauthaud");
    const other = await accessToken("user_oauthaud", { aud: "https://other.example/mcp" });
    const r = await rpc(`Bearer ${other}`, "initialize", { protocolVersion: "2025-06-18" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/resource_metadata=".*oauth-protected-resource", error="invalid_token"/);
    // A non-URL audience (a client id) carries no resource binding and is accepted.
    const plain = await accessToken("user_oauthaud", { aud: "mcp-client-1" });
    expect((await rpc(`Bearer ${plain}`, "initialize", { protocolVersion: "2025-06-18" })).status).toBe(200);
    const expired = await clerkJwt("user_oauthaud", { typ: "at+jwt", exp: 1, claims: { client_id: "c" } });
    expect((await rpc(`Bearer ${expired}`, "ping")).status).toBe(401);
  });

  it("caps each OAuth client's daily spend, and the owner can turn OAuth off", async () => {
    const a = await linked("oauthcap", "user_oauthcap");
    const patch = (body: unknown) => SELF.fetch(`${BASE}/v1/account`, { method: "PATCH", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify(body) });
    expect((await patch({ oauth_daily_cap_micros: 10 })).status).toBe(200);
    const at = await accessToken("user_oauthcap");
    expect((await publish("@oauthcap/a", "1", auth(at))).status).toBe(200);
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) {
      last = await publish("@oauthcap/a", `${i}`, auth(at));
      if (last.status !== 200) break;
    }
    expect(last!.status).toBe(403);
    expect(((await last!.json()) as { error: string }).error).toBe("spend_cap_exceeded");
    // A different client has its own cap.
    const other = await accessToken("user_oauthcap", { client_id: "another-client" });
    expect((await publish("@oauthcap/a", "x", auth(other))).status).toBe(200);
    expect((await patch({ oauth_daily_cap_micros: 0 })).status).toBe(200);
    const off = await publish("@oauthcap/a", "off", auth(other));
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: string }).error).toBe("forbidden");
    expect((await patch({ oauth_daily_cap_micros: -1 })).status).toBe(400);
  });

  it("needs a SubEtha account for the user", async () => {
    const at = await accessToken("user_nobody");
    expect((await publish("@nobody/x", "x", auth(at))).status).toBe(404);
  });

  it("introspects opaque access tokens (RFC 7662) and caches the answer", async () => {
    await linked("opaque", "user_opaque");
    const real = fetch;
    const calls: { url: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://clerk.test/")) return real(input, init);
      const body = String(init?.body ?? "");
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
      const token = new URLSearchParams(body).get("token");
      const active = token === "oat_GOODTOKEN0123456789";
      return Response.json(active ? { active: true, sub: "user_opaque", client_id: "cursor", token_type: "access_token", exp: Math.floor(Date.now() / 1000) + 600 } : { active: false });
    });
    expect((await publish("@opaque/x", "hi", auth("oat_GOODTOKEN0123456789"))).status).toBe(200);
    expect((await publish("@opaque/x", "again", auth("oat_GOODTOKEN0123456789"))).status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://clerk.test/oauth/token_info");
    expect(calls[0]!.auth).toBe(`Basic ${btoa("subetha-rs:rs-secret")}`);
    expect((await publish("@opaque/x", "no", auth("oat_REVOKEDTOKEN0123456"))).status).toBe(401);
  });
});
