// Nightly logical backup of D1 to R2 (PLAN §14 Phase 3), alongside D1 Time Travel's 30-day
// point-in-time restore. Each run writes, under d1/<YYYY-MM-DD>/:
//   <table>.ndjson.gz   one JSON object per row (BLOBs as {"$b64": "…"}), gzip-compressed
//   manifest.json       schema SQL, row counts, SHA-256 of every file, written last
// Account balances live in AccountDOs, but every ledger entry is journaled to D1 with the
// balance after it, so the last ledger_journal row per account restores the balance.
// scripts/restore-d1.mjs turns a downloaded backup into SQL for `wrangler d1 execute`.
import type { Env } from "./types.ts";

const PAGE = 500;
export const BACKUP_PREFIX = "d1/";
const DEFAULT_RETENTION_DAYS = 35;

export interface BackupManifest {
  version: 1;
  environment: string;
  created_at: number;
  day: string;
  tables: { name: string; sql: string; rows: number; file: string; bytes: number; sha256: string }[];
  /** CREATE INDEX / TRIGGER / VIEW statements, replayed after the tables. */
  extra_sql: string[];
}

type Row = Record<string, unknown>;

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function encodeRow(row: Row): string {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      out[k] = { $b64: b64(bytes) };
    } else if (Array.isArray(v)) {
      out[k] = { $b64: b64(Uint8Array.from(v as number[])) }; // D1 returns BLOBs as number[]
    } else {
      out[k] = v;
    }
  }
  return JSON.stringify(out);
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every row of `table`, in rowid order, paged so no single query returns too much. */
async function dumpTable(db: D1Database, table: string): Promise<string[]> {
  const lines: string[] = [];
  let after = -Infinity;
  for (;;) {
    const { results } = await db.prepare(`SELECT rowid AS "__rowid", * FROM ${quoteIdent(table)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`)
      .bind(Number.isFinite(after) ? after : -9007199254740991).all<Row>();
    for (const r of results) {
      after = r.__rowid as number;
      delete r.__rowid;
      lines.push(encodeRow(r));
    }
    if (results.length < PAGE) return lines;
  }
}

/** Writes today's backup to env.BACKUPS. Returns the manifest, or null if no bucket is bound. */
export async function backupDatabase(env: Env, now: number): Promise<BackupManifest | null> {
  const bucket = env.BACKUPS;
  if (!bucket) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const prefix = `${BACKUP_PREFIX}${day}/`;
  const { results: schema } = await env.DB.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 4) != '_cf_' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
  ).all<{ type: string; name: string; sql: string }>();
  const manifest: BackupManifest = { version: 1, environment: env.ENVIRONMENT, created_at: now, day, tables: [], extra_sql: [] };
  for (const s of schema) {
    if (s.type !== "table") {
      manifest.extra_sql.push(s.sql);
      continue;
    }
    const lines = await dumpTable(env.DB, s.name);
    const body = await gzip(lines.length ? lines.join("\n") + "\n" : "");
    const file = `${s.name}.ndjson.gz`;
    await bucket.put(prefix + file, body, { httpMetadata: { contentType: "application/gzip" } });
    manifest.tables.push({ name: s.name, sql: s.sql, rows: lines.length, file, bytes: body.length, sha256: await sha256Hex(body) });
  }
  await bucket.put(prefix + "manifest.json", JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json" } });
  await pruneBackups(bucket, now, Number(env.BACKUP_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS));
  return manifest;
}

/** Deletes backup days older than `days`. A day without a manifest (a failed run) goes too. */
export async function pruneBackups(bucket: R2Bucket, now: number, days: number): Promise<number> {
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    const old = page.objects.map((o) => o.key).filter((k) => (k.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10)) < cutoff);
    if (old.length) await bucket.delete(old);
    deleted += old.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

// ---- restore (shared with scripts/restore-d1.mjs) ----

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "object" && v !== null && "$b64" in v) {
    const bin = atob((v as { $b64: string }).$b64);
    return `X'${[...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Statements that recreate the backup in an empty database: tables, rows (in batches of 100),
 * then indexes and triggers. `rows(table)` returns the decoded NDJSON lines of that table.
 * Run them in one transaction with foreign keys deferred (restore-d1.mjs writes a SQL file).
 */
export function restoreStatements(manifest: BackupManifest, rows: (table: string) => Row[]): string[] {
  const out: string[] = [];
  for (const t of manifest.tables) out.push(t.sql);
  for (const t of manifest.tables) {
    const data = rows(t.name);
    if (data.length !== t.rows) throw new Error(`${t.name}: manifest says ${t.rows} rows, file has ${data.length}`);
    for (let i = 0; i < data.length; i += 100) {
      const batch = data.slice(i, i + 100);
      const cols = Object.keys(batch[0]!);
      out.push(`INSERT INTO ${quoteIdent(t.name)} (${cols.map(quoteIdent).join(", ")}) VALUES ` +
        batch.map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(", ")})`).join(", "));
    }
  }
  out.push(...manifest.extra_sql);
  return out;
}

/** The statements as one SQL file for `wrangler d1 execute --file`. */
export function restoreSql(manifest: BackupManifest, rows: (table: string) => Row[]): string {
  return ["PRAGMA defer_foreign_keys = ON;", ...restoreStatements(manifest, rows).map((s) => `${s};`)].join("\n") + "\n";
}
