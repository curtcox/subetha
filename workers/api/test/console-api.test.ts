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
  });
});
