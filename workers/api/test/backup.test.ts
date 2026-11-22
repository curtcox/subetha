import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { backupDatabase, pruneBackups, restoreStatements, restoreSql, type BackupManifest } from "../src/backup.ts";
import type { Env } from "../src/types.ts";
import { auth, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;

async function gunzipLines(body: ArrayBuffer): Promise<Record<string, unknown>[]> {
  const text = await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function snapshot(tables: string[]) {
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = (await E.DB.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()).results;
  return out;
}

describe("D1 backup", () => {
  it("writes every table to R2 and restores into an empty database", async () => {
    const a = await bootstrap("backup1", 3);
    expect((await publish("@backup1/x", "hello", auth(a.token))).status).toBe(200);
    await E.DB.prepare("INSERT INTO audit_log (account_id, actor, action, detail, time) VALUES (?, 'test', 'quote''s \"test\"', ?, ?)")
      .bind(a.account_id, JSON.stringify({ emoji: "🚪", nl: "a\nb" }), Date.now()).run();

    const now = Date.UTC(2026, 10, 22, 3, 17);
    const m = (await backupDatabase(E, now))!;
    expect(m.day).toBe("2026-11-22");
    const names = m.tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["accounts", "tokens", "ledger_journal", "audit_log", "d1_migrations"]));
    expect(m.extra_sql.some((s) => /CREATE (UNIQUE )?INDEX/i.test(s))).toBe(true);

    const stored = JSON.parse(await (await E.BACKUPS!.get("d1/2026-11-22/manifest.json"))!.text()) as BackupManifest;
    expect(stored).toEqual(m);
    const files: Record<string, Record<string, unknown>[]> = {};
    for (const t of m.tables) {
      const obj = (await E.BACKUPS!.get(`d1/2026-11-22/${t.file}`))!;
      const body = await obj.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(hash, t.name).toBe(t.sha256);
      files[t.name] = await gunzipLines(body);
      expect(files[t.name]!.length, t.name).toBe(t.rows);
    }
    expect(files.accounts!.some((r) => r.handle === "backup1")).toBe(true);

    // Restore: drop everything, replay the statements, compare.
    const before = await snapshot(names);
    const sql = restoreSql(m, (t) => files[t]!);
    expect(sql.startsWith("PRAGMA defer_foreign_keys = ON;")).toBe(true);
    const drops = [...names].reverse().map((t) => E.DB.prepare(`DROP TABLE IF EXISTS "${t}"`));
    await E.DB.batch([E.DB.prepare("PRAGMA defer_foreign_keys = ON"), ...drops]);
    const stmts = restoreStatements(m, (t) => files[t]!);
    await E.DB.batch([E.DB.prepare("PRAGMA defer_foreign_keys = ON"), ...stmts.map((s) => E.DB.prepare(s))]);
    expect(await snapshot(names)).toEqual(before);
  });

  it("prunes old days and skips when no bucket is bound", async () => {
    const day = (d: string) => E.BACKUPS!.put(`d1/${d}/manifest.json`, "{}");
    await day("2026-01-01");
    await day("2026-10-20");
    await day("2026-11-21");
    const deleted = await pruneBackups(E.BACKUPS!, Date.UTC(2026, 10, 22), 30);
    expect(deleted).toBe(2);
    const left = (await E.BACKUPS!.list({ prefix: "d1/" })).objects.map((o) => o.key);
    expect(left).toContain("d1/2026-11-21/manifest.json");
    expect(left.filter((k) => k < "d1/2026-10-23")).toEqual([]);
    expect(await backupDatabase({ ...E, BACKUPS: undefined }, Date.now())).toBeNull();
  });
});
