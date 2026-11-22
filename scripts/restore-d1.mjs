#!/usr/bin/env node
// Turns a nightly D1 backup (workers/api/src/backup.ts) into SQL for `wrangler d1 execute`.
//
//   node --experimental-strip-types scripts/restore-d1.mjs --bucket subetha-backups-production --day 2026-11-22 --out restore.sql
//   node --experimental-strip-types scripts/restore-d1.mjs --dir ./backup-2026-11-22 --out restore.sql
//
// --bucket downloads d1/<day>/* with wrangler (needs Cloudflare credentials) into --dir (default
// ./d1-backup-<day>). Every file's SHA-256 is checked against the manifest before any SQL is
// written. Restore into an EMPTY database (a new D1, or after dropping every table):
//   wrangler d1 execute <db> --remote --file restore.sql
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { restoreSql } from "../workers/api/src/backup.ts";

const { values: args } = parseArgs({ options: { bucket: { type: "string" }, day: { type: "string" }, dir: { type: "string" }, out: { type: "string" } } });
if (!args.dir && !(args.bucket && args.day)) {
  console.error("usage: restore-d1.mjs (--dir <downloaded backup> | --bucket <r2 bucket> --day YYYY-MM-DD) [--out restore.sql]");
  process.exit(2);
}
const dir = args.dir ?? `d1-backup-${args.day}`;
const wrangler = (...a) => execFileSync("pnpm", ["--filter", "@subetha/api", "exec", "wrangler", ...a], { stdio: ["ignore", "inherit", "inherit"] });

if (args.bucket) {
  mkdirSync(dir, { recursive: true });
  const get = (name) => wrangler("r2", "object", "get", `${args.bucket}/d1/${args.day}/${name}`, "--remote", "--file", join(process.cwd(), dir, name));
  get("manifest.json");
  for (const t of JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).tables) get(t.file);
}

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
if (manifest.version !== 1) throw new Error(`unsupported backup version ${manifest.version}`);
const rows = {};
for (const t of manifest.tables) {
  const body = readFileSync(join(dir, t.file));
  const sha = createHash("sha256").update(body).digest("hex");
  if (sha !== t.sha256) throw new Error(`${t.file}: SHA-256 mismatch (backup corrupt or incomplete)`);
  rows[t.name] = gunzipSync(body).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const sql = restoreSql(manifest, (t) => rows[t]);
if (args.out) writeFileSync(args.out, sql);
else process.stdout.write(sql);
const total = manifest.tables.reduce((n, t) => n + t.rows, 0);
console.error(`${manifest.environment} backup of ${manifest.day}: ${manifest.tables.length} tables, ${total} rows${args.out ? ` → ${args.out}` : ""}`);
