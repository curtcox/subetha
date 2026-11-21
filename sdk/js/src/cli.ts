// `subetha` CLI: pub | sub | tail | poll | cost | route | login | balance | token | prices
import { SubEtha, SubEthaError, type PublishOptions } from "./client.ts";
import type { Transport } from "./protocol/index.ts";

interface Io { out: (s: string) => void; err: (s: string) => void; env: Record<string, string | undefined>; readConfig: () => Promise<Config>; writeConfig: (c: Config) => Promise<void> }
export interface Config { baseUrl?: string; token?: string }

const HELP = `subetha — send and receive messages over any transport (https://subetha.org)

Usage:
  subetha pub <topic> [message] [-t title] [-p priority] [--tags a,b] [--mode any|fast|all|cheap]
                                 [--max-cost USD] [--deny sms,voice] [--allow ws,webpush] [--idem KEY]
  subetha sub <topic>[,<topic>…] [--since all|10m|<id>] [--json] [--priority 4,5] [--tags a]
  subetha tail <topic>           alias for sub --since all
  subetha poll <topic> [--since all]
  subetha cost <topic> [message] [pub options]   dry-run: route plan + cost estimate
  subetha route …                alias for cost
  subetha login <token> [--url https://subetha.org]
  subetha balance | prices
  subetha token create --scopes publish:@me/* [--daily-cap USD] [--name NAME]
  subetha token list | token revoke <id>

Environment: SUBETHA_TOKEN, SUBETHA_URL (override the saved login).`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k!] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else if (/^-[a-z]$/.test(a)) {
      flags[a.slice(1)] = argv[i + 1] !== undefined ? argv[++i]! : true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const list = (v: string | true | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const usd = (micros: number) => `$${(micros / 1e6).toFixed(6)}`;

function pubOptions(flags: Record<string, string | true>): PublishOptions {
  const o: PublishOptions = {};
  if (typeof flags.t === "string") o.title = flags.t;
  if (typeof flags.title === "string") o.title = flags.title;
  const p = flags.p ?? flags.priority;
  if (typeof p === "string") {
    const names: Record<string, number> = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };
    o.priority = (names[p] ?? Number(p)) as PublishOptions["priority"];
  }
  if (flags.tags) o.tags = list(flags.tags);
  if (typeof flags.click === "string") o.click = flags.click;
  if (flags.mode || flags["max-cost"] || flags.deny || flags.allow) {
    o.route = {};
    if (typeof flags.mode === "string") o.route.mode = flags.mode as NonNullable<PublishOptions["route"]>["mode"];
    if (typeof flags["max-cost"] === "string") o.route.maxCostUsd = Number(flags["max-cost"]);
    if (flags.deny) o.route.deny = list(flags.deny) as Transport[];
    if (flags.allow) o.route.allow = list(flags.allow) as Transport[];
  }
  if (typeof flags.idem === "string") o.idempotencyKey = flags.idem;
  return o;
}

export async function main(argv: string[], io: Io, readStdin: () => Promise<string>): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift();
  if (!cmd || cmd === "help" || flags.help || flags.h) {
    io.out(HELP);
    return cmd ? 0 : 1;
  }
  const cfg = await io.readConfig();
  const client = new SubEtha({ baseUrl: io.env.SUBETHA_URL ?? cfg.baseUrl, token: io.env.SUBETHA_TOKEN ?? cfg.token });
  try {
    switch (cmd) {
      case "pub":
      case "publish": {
        const topic = pos.shift();
        if (!topic) throw new Error("usage: subetha pub <topic> [message]");
        const message = pos.length ? pos.join(" ") : await readStdin();
        const m = await client.publish(topic, message, pubOptions(flags));
        io.out(flags.json ? JSON.stringify(m) : `published ${m.id} to ${m.topic}`);
        return 0;
      }
      case "cost":
      case "route": {
        const topic = pos.shift();
        if (!topic) throw new Error("usage: subetha cost <topic> [message]");
        const e = await client.estimate(topic, pos.join(" ") || "test", pubOptions(flags));
        if (flags.json) io.out(JSON.stringify(e));
        else {
          io.out(`estimate: ${usd(e.estimate_usd_micros)}`);
          for (const d of e.plan as { transport: string; cost_micros: number; after_s: number }[]) io.out(`  ${d.transport.padEnd(8)} ${usd(d.cost_micros)}${d.after_s ? `  after ${d.after_s}s if unacked` : ""}`);
        }
        return 0;
      }
      case "poll": {
        const topic = pos.shift();
        if (!topic) throw new Error("usage: subetha poll <topic>");
        for (const m of await client.poll(topic.split(","), { since: typeof flags.since === "string" ? flags.since : "all" })) io.out(flags.json ? JSON.stringify(m) : `${m.topic}: ${m.title ? `[${m.title}] ` : ""}${m.message}`);
        return 0;
      }
      case "sub":
      case "subscribe":
      case "tail": {
        const topic = pos.shift();
        if (!topic) throw new Error(`usage: subetha ${cmd} <topic>`);
        const since = typeof flags.since === "string" ? flags.since : cmd === "tail" ? "all" : undefined;
        await new Promise<void>(() => {
          client.subscribe(topic.split(","), (m) => io.out(flags.json ? JSON.stringify(m) : `${m.topic}: ${m.title ? `[${m.title}] ` : ""}${m.message}`), {
            since,
            priority: list(flags.priority)?.map(Number),
            tags: list(flags.tags),
            onError: (e) => io.err(`reconnecting: ${e.message}`),
          });
        });
        return 0;
      }
      case "login": {
        const token = pos.shift();
        if (!token) throw new Error("usage: subetha login <token> [--url URL]");
        const next: Config = { token, baseUrl: typeof flags.url === "string" ? flags.url : cfg.baseUrl };
        const acct = await new SubEtha({ baseUrl: next.baseUrl, token }).account();
        await io.writeConfig(next);
        io.out(`logged in as ${acct.handle ? "@" + acct.handle : acct.id} (balance ${usd(acct.balance_usd_micros)})`);
        return 0;
      }
      case "balance": {
        const b = await client.balance();
        io.out(`available ${usd(b.available_usd_micros)}  reserved ${usd(b.reserved_usd_micros)}`);
        return 0;
      }
      case "prices": {
        io.out(JSON.stringify(await client.prices(), null, 2));
        return 0;
      }
      case "token": {
        const sub = pos.shift();
        if (sub === "create") {
          const t = await client.createToken({ name: typeof flags.name === "string" ? flags.name : undefined, scopes: list(flags.scopes) ?? [], daily_cap_usd: typeof flags["daily-cap"] === "string" ? Number(flags["daily-cap"]) : undefined, transports: list(flags.transports) as Transport[] | undefined });
          io.out(t.token);
          return 0;
        }
        if (sub === "list") { io.out(JSON.stringify((await client.listTokens()).tokens, null, 2)); return 0; }
        if (sub === "revoke" && pos[0]) { await client.revokeToken(pos[0]); io.out("revoked"); return 0; }
        throw new Error("usage: subetha token create|list|revoke");
      }
      default:
        io.err(`unknown command: ${cmd}\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof SubEthaError) io.err(`error: ${e.code} (${e.status}): ${e.message}`);
    else io.err(`error: ${(e as Error).message}`);
    return 2;
  }
}
