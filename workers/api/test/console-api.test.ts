import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/types.ts";
import { auth, BASE, bootstrap } from "./helpers.ts";

const E = env as unknown as Env;
const get = async (token: string, path: string) => SELF.fetch(`${BASE}${path}`, { headers: auth(token) });

describe("console read APIs", () => {
  it("pages through the account's audit log, newest first", async () => {
    const a = await bootstrap("auditor");
    const other = await bootstrap("bystander");
    for (const name of ["one", "two", "three"]) {
      const r = await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ name, scopes: ["publish:@auditor/*"] }) });
      expect(r.status).toBe(201);
    }
    const first = (await (await get(a.token, "/v1/audit?limit=2")).json()) as { entries: { id: number; action: string; detail: { scopes?: string[] } }[]; next_before: number | null };
    expect(first.entries.map((e) => e.action)).toEqual(["token.create", "token.create"]);
    expect(first.entries[0]!.detail.scopes).toEqual(["publish:@auditor/*"]);
    expect(first.entries[0]!.id).toBeGreaterThan(first.entries[1]!.id);
    expect(first.next_before).toBe(first.entries[1]!.id);
    const rest = (await (await get(a.token, `/v1/audit?before=${first.next_before}`)).json()) as { entries: { action: string }[]; next_before: number | null };
    expect(rest.entries.map((e) => e.action)).toContain("token.create");
    expect(rest.next_before).toBeNull();
    const mine = (await (await get(other.token, "/v1/audit")).json()) as { entries: unknown[] };
    expect(mine.entries).toEqual([]);
  });

  it("needs an admin credential for the audit log", async () => {
    const a = await bootstrap("auditor2");
    const r = await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ scopes: ["publish:@auditor2/*"] }) });
    const { token } = (await r.json()) as { token: string };
    expect((await get(token, "/v1/audit")).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/audit`)).status).toBe(401);
  });

  it("lists the account's Slack workspaces", async () => {
    const a = await bootstrap("slacker");
    const b = await bootstrap("other");
    await E.DB.prepare("INSERT INTO slack_teams (team_id, account_id, team_name, bot_token, created_at) VALUES ('T1', ?, 'Acme', 'xoxb-secret', 1)").bind(a.account_id).run();
    await E.DB.prepare("INSERT INTO slack_teams (team_id, account_id, team_name, bot_token, created_at) VALUES ('T2', ?, 'Other', 'xoxb-other', 2)").bind(b.account_id).run();
    const r = (await (await get(a.token, "/v1/slack/teams")).json()) as { teams: Record<string, unknown>[] };
    expect(r.teams).toEqual([{ team_id: "T1", team_name: "Acme", created_at: 1 }]);
    expect(JSON.stringify(r)).not.toContain("xoxb");

    // Bind a channel, list it, and unbind it.
    await SELF.fetch(`${BASE}/v1/topics/@slacker/ops`, { method: "PUT", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({}) });
    const bound = await SELF.fetch(`${BASE}/v1/slack/bindings`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ team_id: "T1", channel: "C12345678", topic: "@slacker/ops" }) });
    expect(bound.status).toBe(201);
    const { endpoint_id } = (await bound.json()) as { endpoint_id: string };
    const list = (await (await get(a.token, "/v1/slack/bindings")).json()) as { bindings: { team_id: string; team_name: string; channel: string; topic: string; endpoint_id: string }[] };
    expect(list.bindings).toHaveLength(1);
    expect(list.bindings[0]).toMatchObject({ team_id: "T1", team_name: "Acme", channel: "C12345678", topic: "@slacker/ops", endpoint_id });
    expect(((await (await get(b.token, "/v1/slack/bindings")).json()) as { bindings: unknown[] }).bindings).toEqual([]);
    expect((await SELF.fetch(`${BASE}/v1/slack/bindings?team_id=T1&channel=C12345678`, { method: "DELETE", headers: auth(b.token) })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/slack/bindings?team_id=T1&channel=C12345678`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);
    expect(((await (await get(a.token, "/v1/slack/bindings")).json()) as { bindings: unknown[] }).bindings).toEqual([]);
    // Outbound Slack endpoint was also removed.
    const eps = (await (await get(a.token, "/v1/endpoints")).json()) as { endpoints: { id: string }[] };
    expect(eps.endpoints.some((e) => e.id === endpoint_id)).toBe(false);
  });

  it("reports aggregate subscriber counts on GET /v1/topics and GET /v1/topics/:topic", async () => {
    const a = await bootstrap("counter");
    const topic = "@counter/bell";
    await SELF.fetch(`${BASE}/v1/topics/${topic}`, { method: "PUT", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({}) });
    const ep = (await (await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ kind: "webhook", address: "https://example.com/hook" }) })).json()) as { id: string };
    expect((await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token, { "content-type": "application/json" }), body: JSON.stringify({ topic, endpoint_id: ep.id }) })).status).toBe(201);

    const list = (await (await get(a.token, "/v1/topics")).json()) as { topics: { name: string; endpoint_subscriptions: number }[] };
    expect(list.topics.find((t) => t.name === topic)?.endpoint_subscriptions).toBe(1);
    const detail = (await (await get(a.token, `/v1/topics/${topic}`)).json()) as { subscribers: { live: number; queued: number } };
    expect(detail.subscribers).toEqual({ live: 0, queued: 1 });
  });
});
