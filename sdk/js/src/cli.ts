// `subetha` CLI: pub | sub | tail | poll | cost | route | trace | ack | login | logout | whoami | lan | balance | prices | token | topics | devices
import { enrollmentProof, SubEtha, SubEthaError, type PublishOptions } from "./client.ts";
import { GossipNode } from "./edge/gossip.ts";
import type { LanHandle, LanOptions } from "./edge/lan-node.ts";
import { base64urlDecode, base64urlEncode, deviceKeyFromSeed, generateDeviceKey, isTopic, signEnvelope, ulid, type Envelope, type Transport } from "./protocol/index.ts";

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  readConfig: () => Promise<Config>;
  writeConfig: (c: Config) => Promise<void>;
  /** Optional custom fetch (for tests). */
  fetch?: typeof fetch;
  /** Read a local file for `pub --file` / `cost --file`. */
  readFile?: (path: string) => Promise<{ name: string; bytes: Uint8Array }>;
  /** Default device name for `subetha login` (device-code flow). */
  hostname?: string;
  /** Override sleep between device-code polls (for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** LAN shim (Node only): see edge/lan-node.ts. */
  startLan?: (node: GossipNode, onMessage: (e: Envelope) => void, opts?: LanOptions) => Promise<LanHandle>;
}
export interface Config { baseUrl?: string; token?: string; deviceSeed?: string; deviceId?: string }

const HELP = `subetha — send and receive messages over any transport (https://subetha.us)

Usage:
  subetha pub <topic> [message] [-t title] [-p priority] [--tags a,b] [--click URL] [--icon URL]
                                 [--actions JSON] [--markdown | --content-type MIME] [--expires UNIX]
                                 [--hops N] [--key BASE64URL [--kid ID]] [--sign | --no-sign]
                                 [--file PATH] [--mode any|fast|all|cheap] [--deadline SECONDS]
                                 [--max-cost USD] [--deny sms,voice] [--allow ws,webpush] [--idem KEY]
  subetha sub <topic>[,<topic>…] [--since all|10m|<id>] [--json] [--priority 4,5] [--tags a]
                                 [--transport auto|ws|stream|poll] [--verify] [--require-signature]
                                 [--no-ack] [--key BASE64URL [--kid ID]]
  subetha tail <topic>           alias for sub --since all
  subetha poll <topic> [--since all] [--priority 4,5] [--tags a] [--key BASE64URL]
  subetha cost <topic> [message] [pub options]   dry-run: route plan + cost estimate
  subetha route …                alias for cost
  subetha trace <topic> <id>     show delivery plan, events, ack, and cost for a message
  subetha ack <topic> <id>       acknowledge a message (stops escalation)
  subetha login [token] [--url https://subetha.us] [--name DEVICE_NAME]
                                 with a token: save it; without one: enroll this CLI via device code
  subetha logout                 clear saved token and device credentials
  subetha whoami                 show current account / device login
  subetha lan <topic>[,<topic>…] [--send MESSAGE] [--hops 2] [--relay t1,t2] [--for SECONDS] [--json]
                                 offline: gossip with SubEtha peers on the local network (no relay, free)
  subetha balance | prices
  subetha topics list | topics delete <topic>
  subetha devices list | devices approve <USER-CODE> | devices revoke <device_id>
  subetha token create --scopes publish:@me/* [--daily-cap USD] [--total-cap USD] [--expires-hours H]
                       [--transports a,b] [--deny-transports a,b] [--origins URL] [--ips CIDR] [--name NAME]
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

/** Envelope fields from -t/-p/--tags for messages built locally (LAN). */
function pubFields(flags: Record<string, string | true>): Partial<Envelope> {
  const o = pubOptions(flags);
  return { ...(o.title ? { title: o.title } : {}), ...(o.priority ? { priority: o.priority } : {}), ...(o.tags ? { tags: o.tags } : {}) };
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
};
function mimeFor(name: string): string {
  const m = /\.[a-z0-9]+$/i.exec(name);
  return (m && MIME_BY_EXT[m[0].toLowerCase()]) || "application/octet-stream";
}

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
  if (typeof flags.icon === "string") o.icon = flags.icon;
  if (typeof flags.actions === "string") o.actions = JSON.parse(flags.actions) as PublishOptions["actions"];
  if (flags.markdown) o.contentType = "text/markdown";
  else if (typeof flags["content-type"] === "string") o.contentType = flags["content-type"] as PublishOptions["contentType"];
  if (typeof flags.expires === "string") o.expires = Number(flags.expires);
  if (typeof flags.hops === "string") o.hops = Number(flags.hops);
  if (flags["no-sign"]) o.sign = false;
  else if (flags.sign) o.sign = true;
  if (flags.mode || flags["max-cost"] || flags.deny || flags.allow || flags.deadline) {
    o.route = {};
    if (typeof flags.mode === "string") o.route.mode = flags.mode as NonNullable<PublishOptions["route"]>["mode"];
    if (typeof flags["max-cost"] === "string") o.route.maxCostUsd = Number(flags["max-cost"]);
    if (flags.deny) o.route.deny = list(flags.deny) as Transport[];
    if (flags.allow) o.route.allow = list(flags.allow) as Transport[];
    if (typeof flags.deadline === "string") o.route.deadlineS = Number(flags.deadline);
  }
  if (typeof flags.idem === "string") o.idempotencyKey = flags.idem;
  return o;
}

function applyCliKey(client: SubEtha, topics: string[], flags: Record<string, string | true>) {
  if (typeof flags.key !== "string") return;
  const key = base64urlDecode(flags.key);
  const kid = typeof flags.kid === "string" ? flags.kid : "cli";
  for (const t of topics) client.setTopicKey(t, { kid, key });
}

export async function main(argv: string[], io: Io, readStdin: () => Promise<string>): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift();
  if (!cmd || cmd === "help" || flags.help || flags.h) {
    io.out(HELP);
    return cmd ? 0 : 1;
  }
  const cfg = await io.readConfig();
  const baseUrl = io.env.SUBETHA_URL ?? (typeof flags.url === "string" ? flags.url : cfg.baseUrl);
  const token = io.env.SUBETHA_TOKEN ?? cfg.token;
  const deviceKey = !token && cfg.deviceSeed ? await deviceKeyFromSeed(base64urlDecode(cfg.deviceSeed)) : undefined;
  const client = new SubEtha({ baseUrl, token, deviceKey, signRequests: !!deviceKey, fetch: io.fetch });
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    switch (cmd) {
      case "pub":
      case "publish": {
        const topic = pos.shift();
        if (!topic) throw new Error("usage: subetha pub <topic> [message]");
        applyCliKey(client, [topic], flags);
        const filePath = typeof flags.file === "string" ? flags.file : typeof flags.f === "string" ? flags.f : null;
        let m: Envelope;
        if (filePath) {
          if (!io.readFile) throw new Error("--file needs filesystem access");
          const file = await io.readFile(filePath);
          const message = pos.length ? pos.join(" ") : undefined;
          m = await client.publishFile(topic, { ...file, type: mimeFor(file.name) }, { ...pubOptions(flags), message });
        } else {
          const message = pos.length ? pos.join(" ") : await readStdin();
          m = await client.publish(topic, message, pubOptions(flags));
        }
        io.out(flags.json ? JSON.stringify(m) : `published ${m.id} to ${m.topic}`);
        return 0;
      }
      case "cost":
      case "route": {
        const topic = pos.shift();
        if (!topic) throw new Error("usage: subetha cost <topic> [message]");
        const filePath = typeof flags.file === "string" ? flags.file : typeof flags.f === "string" ? flags.f : null;
        const e = filePath
          ? await (async () => {
              if (!io.readFile) throw new Error("--file needs filesystem access");
              const file = await io.readFile(filePath);
              return client.estimateFile(topic, { ...file, type: mimeFor(file.name) }, { ...pubOptions(flags), message: pos.length ? pos.join(" ") : undefined });
            })()
          : await client.estimate(topic, pos.join(" ") || "test", pubOptions(flags));
        if (flags.json) io.out(JSON.stringify(e));
        else {
          io.out(`estimate: ${usd(e.estimate_usd_micros)}`);
          for (const d of e.plan as { transport: string; cost_micros: number; after_s: number }[]) io.out(`  ${d.transport.padEnd(8)} ${usd(d.cost_micros)}${d.after_s ? `  after ${d.after_s}s if unacked` : ""}`);
        }
        return 0;
      }
      case "trace": {
        const topic = pos.shift(), id = pos.shift();
        if (!topic || !id) throw new Error("usage: subetha trace <topic> <id>");
        io.out(JSON.stringify(await client.trace(topic, id), null, 2));
        return 0;
      }
      case "ack": {
        const topic = pos.shift(), id = pos.shift();
        if (!topic || !id) throw new Error("usage: subetha ack <topic> <id>");
        await client.ack(topic, id, "cli");
        io.out(`acked ${id} on ${topic}`);
        return 0;
      }
      case "poll": {
        const topic = pos.shift();
        if (!topic) throw new Error("usage: subetha poll <topic>");
        const topics = topic.split(",");
        applyCliKey(client, topics, flags);
        if (deviceKey && !flags.key) await client.loadTopicKeys().catch(() => {});
        const msgs = await client.poll(topics, {
          since: typeof flags.since === "string" ? flags.since : "all",
          priority: list(flags.priority)?.map(Number),
          tags: list(flags.tags),
        });
        for (const m of msgs) io.out(flags.json ? JSON.stringify(m) : `${m.topic}: ${m.title ? `[${m.title}] ` : ""}${m.message}`);
        return 0;
      }
      case "sub":
      case "subscribe":
      case "tail": {
        const topic = pos.shift();
        if (!topic) throw new Error(`usage: subetha ${cmd} <topic>`);
        const topics = topic.split(",");
        applyCliKey(client, topics, flags);
        if (deviceKey && !flags.key) await client.loadTopicKeys().catch(() => {});
        const since = typeof flags.since === "string" ? flags.since : cmd === "tail" ? "all" : undefined;
        await new Promise<void>(() => {
          client.subscribe(topics, (m) => io.out(flags.json ? JSON.stringify(m) : `${m.topic}: ${m.title ? `[${m.title}] ` : ""}${m.message}`), {
            since,
            priority: list(flags.priority)?.map(Number),
            tags: list(flags.tags),
            transport: typeof flags.transport === "string" ? (flags.transport as "auto" | "ws" | "stream" | "poll") : undefined,
            verify: !!flags.verify,
            requireSignature: !!flags["require-signature"],
            autoAck: !flags["no-ack"],
            onError: (e) => io.err(`reconnecting: ${e.message}`),
          });
        });
        return 0;
      }
      case "lan": {
        const topics = (pos.shift() ?? "").split(",").filter(Boolean);
        if (!topics.length || !topics.every(isTopic)) throw new Error("usage: subetha lan <topic>[,<topic>…] [--send MESSAGE]");
        if (!io.startLan) throw new Error("LAN gossip needs Node (UDP)");
        const node = new GossipNode();
        topics.forEach((t) => node.subscribe(t));
        list(flags.relay)?.forEach((t) => node.setRelayable(t, true));
        const lan = await io.startLan(node, (m) => io.out(flags.json ? JSON.stringify(m) : `${m.topic}: ${m.title ? `[${m.title}] ` : ""}${m.message}`), {
          port: typeof flags.port === "string" ? Number(flags.port) : undefined,
        });
        io.err(`lan node ${lan.nodeId} listening on udp ${lan.unicastPort}`);
        if (typeof flags.send === "string") {
          const now = Math.floor(Date.now() / 1000);
          const hops = typeof flags.hops === "string" ? Number(flags.hops) : 2;
          let env: Envelope = { id: ulid(), time: now, expires: now + 86_400, topic: topics[0]!, message: flags.send, hops, ...pubFields(flags) };
          if (deviceKey && !flags["no-sign"]) env = await signEnvelope(env, deviceKey);
          node.publish(env);
          await lan.resync();
        }
        const seconds = typeof flags.for === "string" ? Number(flags.for) : Infinity;
        await new Promise((r) => (Number.isFinite(seconds) ? setTimeout(r, seconds * 1000) : undefined));
        await lan.stop();
        return 0;
      }
      case "login": {
        const tok = pos.shift();
        const url = typeof flags.url === "string" ? flags.url : cfg.baseUrl;
        if (tok) {
          const next: Config = { token: tok, baseUrl: url };
          const acct = await new SubEtha({ baseUrl: next.baseUrl, token: tok, fetch: io.fetch }).account();
          await io.writeConfig(next);
          io.out(`logged in as ${acct.handle ? "@" + acct.handle : acct.id} (balance ${usd(acct.balance_usd_micros)})`);
          return 0;
        }
        // Device-code enrollment (PLAN §9): no bearer token stored on disk; the CLI signs requests.
        const anon = new SubEtha({ baseUrl: url, fetch: io.fetch });
        const key = await generateDeviceKey();
        const proof = await enrollmentProof(key);
        const name = typeof flags.name === "string" ? flags.name : io.hostname ? `cli (${io.hostname})` : "subetha-cli";
        const started = await anon.startDeviceCode({ ...proof, name, capabilities: ["ws", "lan"] });
        io.out(`Open ${started.verification_uri_complete ?? started.verification_uri} and enter code: ${started.user_code}`);
        const intervalMs = Math.max(1, started.interval ?? 5) * 1000;
        const deadline = Date.now() + (started.expires_in ?? 600) * 1000;
        for (;;) {
          if (Date.now() > deadline) throw new Error("device code expired before approval");
          await sleep(intervalMs);
          const { ok, status, data } = await anon.pollDeviceToken(started.device_code);
          if (ok && data.device_id) {
            await io.writeConfig({ baseUrl: url, deviceSeed: base64urlEncode(key.seed!), deviceId: data.device_id });
            io.out(`enrolled device ${data.device_id} (account ${data.account_id})`);
            return 0;
          }
          if (data.error === "authorization_pending") continue;
          throw new Error(data.error ?? `device login failed (HTTP ${status})`);
        }
      }
      case "logout": {
        await io.writeConfig({ baseUrl: cfg.baseUrl });
        io.out("logged out");
        return 0;
      }
      case "whoami": {
        if (deviceKey) {
          io.out(flags.json ? JSON.stringify({ kind: "device", device_id: deviceKey.deviceId, base_url: client.baseUrl }) : `device ${deviceKey.deviceId} (${client.baseUrl})`);
          return 0;
        }
        const acct = await client.account();
        io.out(flags.json ? JSON.stringify(acct) : `${acct.handle ? "@" + acct.handle : acct.id} (${acct.tier}, balance ${usd(acct.balance_usd_micros)})`);
        return 0;
      }
      case "topics": {
        const sub = pos.shift();
        if (!sub || sub === "list") { io.out(JSON.stringify((await client.topics()).topics, null, 2)); return 0; }
        if (sub === "delete" && pos[0]) { await client.deleteTopic(pos[0]); io.out(`deleted ${pos[0]}`); return 0; }
        throw new Error("usage: subetha topics list|delete <topic>");
      }
      case "devices": {
        const sub = pos.shift();
        if (!sub || sub === "list") { io.out(JSON.stringify((await client.listDevices()).devices, null, 2)); return 0; }
        if (sub === "approve" && pos[0]) { io.out(JSON.stringify(await client.approveDevice(pos[0]), null, 2)); return 0; }
        if (sub === "revoke" && pos[0]) { await client.revokeDevice(pos[0]); io.out(`revoked ${pos[0]}`); return 0; }
        throw new Error("usage: subetha devices list|approve <USER-CODE>|revoke <device_id>");
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
          const t = await client.createToken({
            name: typeof flags.name === "string" ? flags.name : undefined,
            scopes: list(flags.scopes) ?? [],
            daily_cap_usd: typeof flags["daily-cap"] === "string" ? Number(flags["daily-cap"]) : undefined,
            total_cap_usd: typeof flags["total-cap"] === "string" ? Number(flags["total-cap"]) : undefined,
            expires_in_s: typeof flags["expires-hours"] === "string" ? Math.round(Number(flags["expires-hours"]) * 3600) : undefined,
            transports: list(flags.transports) as Transport[] | undefined,
            deny_transports: list(flags["deny-transports"]) as Transport[] | undefined,
            origins: list(flags.origins),
            ips: list(flags.ips),
          });
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
