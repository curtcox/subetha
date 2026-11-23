import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "@subetha/sdk/protocol";
import { enrollmentProof } from "@subetha/sdk";
import { signClerkWebhook, verifyClerkWebhook } from "../src/clerk.ts";
import { accountStub } from "../src/durable/account.ts";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap, clerkJwt, publish } from "./helpers.ts";

const E = env as unknown as Env;
const SECRET = "whsec_dGVzdC1jbGVyay13ZWJob29rLXNlY3JldA==";

async function postClerkHook(body: unknown, opts: { id?: string; ts?: string; sig?: string } = {}) {
  const payload = JSON.stringify(body);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2, 12)}`;
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = opts.sig ?? (await signClerkWebhook(payload, SECRET, id, ts));
  return SELF.fetch(`${BASE}/v1/hooks/clerk`, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": sig },
    body: payload,
  });
}

describe("Clerk webhooks and organization roles", () => {
  it("verifies Svix signatures and rejects stale or tampered payloads", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = '{"type":"user.updated","data":{"id":"user_1"}}';
    const sig = await signClerkWebhook(payload, SECRET, "msg_1", String(now));
    expect(await verifyClerkWebhook(payload, { id: "msg_1", timestamp: String(now), signature: sig }, SECRET, now)).toBe(true);
    // Multiple space-separated signatures (key rotation): second one valid.
    expect(await verifyClerkWebhook(payload, { id: "msg_1", timestamp: String(now), signature: `v1,deadbeef ${sig}` }, SECRET, now)).toBe(true);
    // Tampered payload fails.
    expect(await verifyClerkWebhook(payload + " ", { id: "msg_1", timestamp: String(now), signature: sig }, SECRET, now)).toBe(false);
    // Stale timestamp (>300s) fails.
    expect(await verifyClerkWebhook(payload, { id: "msg_1", timestamp: String(now - 301), signature: sig }, SECRET, now)).toBe(false);
  });

  it("syncs email on user.updated and dedupes by svix-id", async () => {
    const a = await bootstrap("clerkemail", 5);
    await E.DB.prepare("UPDATE accounts SET clerk_id = ?, email = ? WHERE id = ?").bind("user_email_sync", "old@example.com", a.account_id).run();

    // Bad signature rejected.
    expect((await postClerkHook({ type: "user.updated", data: { id: "user_email_sync" } }, { sig: "v1,bad" })).status).toBe(401);

    const id = "msg_email_sync_1";
    const event = {
      type: "user.updated",
      data: {
        id: "user_email_sync",
        primary_email_address_id: "idn_2",
        email_addresses: [
          { id: "idn_1", email_address: "old@example.com" },
          { id: "idn_2", email_address: "new@example.com" },
        ],
      },
    };
    const r1 = await postClerkHook(event, { id });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ received: true });

    const acct = (await (await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).json()) as { email: string };
    expect(acct.email).toBe("new@example.com");

    // Duplicate svix-id is idempotent.
    const r2 = await postClerkHook(event, { id });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ received: true, duplicate: true });
  });

  it("pauses the account and revokes tokens and devices on user.deleted and organization.deleted", async () => {
    const a = await bootstrap("clerkdel", 5);
    await E.DB.prepare("UPDATE accounts SET clerk_id = ?, stripe_customer_id = 'cus_x', auto_recharge = '{\"threshold_micros\":1000000,\"amount_micros\":5000000}' WHERE id = ?")
      .bind("user_to_delete", a.account_id).run();
    await accountStub(E, a.account_id).setAutoRecharge({ threshold_micros: 1_000_000, amount_micros: 5_000_000, customer: "cus_x" });

    // Enroll a device on this account.
    const key = await generateDeviceKey();
    const proof = await enrollmentProof(key);
    expect((await SELF.fetch(`${BASE}/v1/devices`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ ...proof, name: "laptop" }),
    })).status).toBe(201);

    // Trigger user.deleted webhook.
    const r = await postClerkHook({ type: "user.deleted", data: { id: "user_to_delete" } });
    expect(r.status).toBe(200);

    // Account is paused, auto_recharge cleared, tokens & devices revoked.
    const row = await E.DB.prepare("SELECT paused, auto_recharge FROM accounts WHERE id = ?").bind(a.account_id).first<{ paused: number; auto_recharge: string | null }>();
    expect(row?.paused).toBe(1);
    expect(row?.auto_recharge).toBeNull();
    const dev = await E.DB.prepare("SELECT revoked_at FROM devices WHERE id = ?").bind(key.deviceId).first<{ revoked_at: number | null }>();
    expect(dev?.revoked_at).not.toBeNull();

    // Existing token is immediately rejected (cache invalidated).
    expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(a.token) })).status).toBe(401);
    // AccountDO rejects charges while paused.
    const charge = await accountStub(E, a.account_id).charge(5, "after-del", null, {});
    expect(charge.ok).toBe(false);

    // Also test organization.deleted.
    const org = await bootstrap("orgdel", 5);
    await E.DB.prepare("UPDATE accounts SET clerk_id = ? WHERE id = ?").bind("org_to_delete", org.account_id).run();
    expect((await postClerkHook({ type: "organization.deleted", data: { id: "org_to_delete" } })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(org.token) })).status).toBe(401);
  });

  it("requires org admin role for org account management while letting members publish and subscribe", async () => {
    const memberJwt = await clerkJwt("user_mem", { claims: { org_id: "org_acme", org_role: "org:member" } });
    const noRoleJwt = await clerkJwt("user_norole", { claims: { org_id: "org_acme" } });
    const adminJwt = await clerkJwt("user_adm", { claims: { org_id: "org_acme", org_role: "org:admin" } });
    const v2AdminJwt = await clerkJwt("user_adm2", { claims: { o: { id: "org_acme", rol: "admin" } } });
    const v2MemberJwt = await clerkJwt("user_mem2", { claims: { o: { id: "org_acme", rol: "basic_member" } } });

    // Non-admin cannot create the org account.
    expect((await SELF.fetch(`${BASE}/v1/account`, {
      method: "POST",
      headers: auth(memberJwt, { "content-type": "application/json" }),
      body: JSON.stringify({ handle: "acmeorg" }),
    })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/account`, {
      method: "POST",
      headers: auth(noRoleJwt, { "content-type": "application/json" }),
      body: JSON.stringify({ handle: "acmeorg" }),
    })).status).toBe(403);

    // Org admin creates the org account and funds it.
    const created = await SELF.fetch(`${BASE}/v1/account`, {
      method: "POST",
      headers: auth(adminJwt, { "content-type": "application/json" }),
      body: JSON.stringify({ handle: "acmeorg" }),
    });
    expect(created.status).toBe(201);
    const { id: orgAccountId } = (await created.json()) as { id: string };
    await accountStub(E, orgAccountId).topup(5_000_000, "test:org");

    // Org admin (both v1 and v2 claims) can read account and manage tokens/topics.
    expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(adminJwt) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(v2AdminJwt) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/topics/@acmeorg/alerts`, {
      method: "PUT",
      headers: auth(adminJwt, { "content-type": "application/json" }),
      body: JSON.stringify({ policy: {} }),
    })).status).toBe(201);

    // Non-admin org members cannot call admin endpoints (v1 or v2 claims).
    for (const jwt of [memberJwt, noRoleJwt, v2MemberJwt]) {
      expect((await SELF.fetch(`${BASE}/v1/account`, { headers: auth(jwt) })).status).toBe(403);
      expect((await SELF.fetch(`${BASE}/v1/tokens`, { headers: auth(jwt) })).status).toBe(403);
      expect((await SELF.fetch(`${BASE}/v1/topics/@acmeorg/alerts`, {
        method: "PUT",
        headers: auth(jwt, { "content-type": "application/json" }),
        body: JSON.stringify({ policy: { paused: true } }),
      })).status).toBe(403);
    }

    // Non-admin org members CAN still publish, poll, and ack on the org's topics.
    const pub = await publish("@acmeorg/alerts", "deploy finished", auth(memberJwt));
    expect(pub.status).toBe(200);
    const msg = (await pub.json()) as { id: string };
    const polled = await SELF.fetch(`${BASE}/@acmeorg/alerts/json?poll=1`, { headers: auth(v2MemberJwt) });
    expect(polled.status).toBe(200);
    expect(await polled.text()).toContain("deploy finished");
    const acked = await SELF.fetch(`${BASE}/v1/ack`, {
      method: "POST",
      headers: auth(memberJwt, { "content-type": "application/json" }),
      body: JSON.stringify({ topic: "@acmeorg/alerts", id: msg.id }),
    });
    expect(acked.status).toBe(200);
  });
});
