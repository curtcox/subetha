// Node entry point for the CLI.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { main, type Config } from "./cli.ts";
import { startLan } from "./edge/lan-node.ts";

const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "subetha");
const file = join(dir, "config.json");

const code = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env,
  hostname: hostname(),
  readFile: async (p) => ({ name: basename(p), bytes: new Uint8Array(await readFile(p)) }),
  readConfig: async () => { try { return JSON.parse(await readFile(file, "utf8")) as Config; } catch { return {}; } },
  writeConfig: async (c) => { await mkdir(dir, { recursive: true }); await writeFile(file, JSON.stringify(c, null, 2), { mode: 0o600 }); },
  startLan,
}, async () => {
  if (process.stdin.isTTY) return "triggered";
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.replace(/\n$/, "");
});
process.exit(code);
