// Parsing ntfy-compatible publish and subscribe requests (spec §8).
import { isTopic, parsePriority, type Envelope, type RouteMode, type Transport, TRANSPORTS, MAX_MESSAGE_BYTES, utf8 } from "@subetha/sdk/protocol";
import { ApiError } from "./errors.ts";
import type { SubscriptionFilter } from "./types.ts";

const RESERVED = new Set(["v1", "console", "docs", "file", "mcp", "sdk.js", "llms.txt", "llms-full.txt", "openapi.yaml", ".well-known", "favicon.ico", "static", "assets", "hooks", "robots.txt"]);
const FORMATS = new Set(["json", "sse", "raw", "ws", "auth"]);

export interface TopicPath { topics: string[]; format: string | null }

/** Parses `/@alice/doorbell/json`, `/t_xxx/sse`, `/t_a,t_b/json`, `/@alice/doorbell`. Returns null for non-topic paths. */
export function parseTopicPath(pathname: string): TopicPath | null {
  const path = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  const first = path.split("/")[0]!;
  if (RESERVED.has(first)) return null;
  const all = path.split(",");
  const slash = path.lastIndexOf("/");
  const last = path.slice(slash + 1);
  // "@alice/ws" is a topic named "ws"; "@alice/x/ws" is topic "@alice/x" with format ws.
  if (slash > 0 && FORMATS.has(last)) {
    const rest = path.slice(0, slash).split(",");
    if (rest.every(isTopic)) return { topics: rest, format: last };
  }
  const topics = all;
  if (!topics.every(isTopic)) {
    // Not a topic: let the caller decide (404 / invalid_topic).
    if (first.startsWith("@") || first.startsWith("t_")) throw new ApiError("invalid_topic", `invalid topic: ${path}`);
    return null;
  }
  const format: string | null = null;
  return { topics, format };
}

function header(req: Request, url: URL, ...names: string[]): string | null {
  for (const n of names) {
    const v = req.headers.get(n) ?? url.searchParams.get(n.toLowerCase().replace(/^x-/, ""));
    if (v !== null && v !== "") return v;
  }
  return null;
}

function transports(v: string | null): Transport[] {
  if (!v) return [];
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of list) if (!(TRANSPORTS as readonly string[]).includes(t)) throw new ApiError("bad_request", `unknown transport: ${t}`);
  return list as Transport[];
}

/** RFC 2047 encoded-word decoding for non-ASCII header values (ntfy clients send these). */
function decodeHeader(v: string | null): string | null {
  if (!v) return v;
  return v.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, enc: string, text: string) => {
    if (enc.toLowerCase() === "b") return utf8.decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
    return text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
  });
}

export interface ParsedPublish {
  envelope: Envelope;
  route: { mode: RouteMode; maxCost: number | null; deny: Transport[]; allow: Transport[] | null };
  dryRun: boolean;
  idempotencyKey: string | null;
}

function parseRoute(req: Request, url: URL, env: Envelope) {
  const modeRaw = header(req, url, "X-Route-Mode") ?? env.route?.mode ?? "any";
  if (!["any", "fast", "all", "cheap"].includes(modeRaw)) throw new ApiError("bad_request", "invalid X-Route-Mode");
  const maxCostHdr = header(req, url, "X-Max-Cost");
  let maxCost: number | null = env.route?.max_cost_usd_micros ?? null;
  if (maxCostHdr !== null) {
    const usd = Number(maxCostHdr);
    if (!Number.isFinite(usd) || usd < 0) throw new ApiError("bad_request", "invalid X-Max-Cost");
    maxCost = Math.floor(usd * 1e6);
  }
  const deny = [...transports(header(req, url, "X-Deny")), ...(env.route?.deny ?? [])];
  const allowHdr = header(req, url, "X-Allow");
  const allow = allowHdr ? transports(allowHdr) : env.route?.allow ?? null;
  return { mode: modeRaw as RouteMode, maxCost, deny, allow };
}

/** Publish via PUT/POST /<topic> with ntfy headers. */
export async function parseHeaderPublish(req: Request, topic: string): Promise<ParsedPublish> {
  const url = new URL(req.url);
  if (header(req, url, "X-Delay", "Delay", "X-At", "X-In")) throw new ApiError("unsupported", "scheduled delivery (X-Delay) is not supported in v0");
  const buf = new Uint8Array(await req.arrayBuffer());
  const env: Envelope = { topic };
  const filename = header(req, url, "X-Filename", "Filename", "f");
  const bodyText = utf8.decode(buf);
  if (filename) throw new ApiError("unsupported", "attachments: upload via PUT /v1/files then set X-Attach");
  if (buf.length > MAX_MESSAGE_BYTES) throw new ApiError("message_too_large");
  const msgParam = url.searchParams.get("message") ?? url.searchParams.get("m");
  env.message = bodyText !== "" ? bodyText : msgParam ?? "triggered";
  const title = decodeHeader(header(req, url, "X-Title", "Title", "t"));
  if (title) env.title = title;
  let prio: number | undefined;
  try {
    prio = parsePriority(header(req, url, "X-Priority", "Priority", "prio", "p"));
  } catch {
    throw new ApiError("invalid_message", "priority must be 1-5 or min|low|default|high|max|urgent");
  }
  if (prio !== undefined && prio !== 3) env.priority = prio;
  const tags = decodeHeader(header(req, url, "X-Tags", "Tags", "Tag", "ta"));
  if (tags) env.tags = tags.split(",").map((s) => s.trim()).filter(Boolean);
  const click = header(req, url, "X-Click", "Click");
  if (click) env.click = click;
  const icon = header(req, url, "X-Icon", "Icon");
  if (icon) env.icon = icon;
  const attach = header(req, url, "X-Attach", "Attach", "a");
  if (attach) env.attachment = { name: url.searchParams.get("filename") ?? attach.split("/").pop() ?? "file", url: attach };
  const md = header(req, url, "X-Markdown", "Markdown", "md");
  if (md && ["1", "yes", "true"].includes(md.toLowerCase())) env.content_type = "text/markdown";
  const actions = header(req, url, "X-Actions", "Actions");
  if (actions) env.actions = parseActions(actions);
  const sender = header(req, url, "X-Sender"), sig = header(req, url, "X-Signature"), id = header(req, url, "X-Message-Id"), time = header(req, url, "X-Time");
  if (sender) env.sender = sender;
  if (sig) env.sig = sig;
  if (id) env.id = id;
  if (time) env.time = Number(time);
  const expires = header(req, url, "X-Expires");
  if (expires) env.expires = Number(expires);
  const route = parseRoute(req, url, env);
  return { envelope: env, route, dryRun: ["1", "true", "yes"].includes((header(req, url, "X-Dry-Run") ?? "").toLowerCase()), idempotencyKey: req.headers.get("idempotency-key") };
}

/** ntfy action header: "view, Open, https://…; http, Close, https://…, clear=true" or JSON. */
export function parseActions(s: string): NonNullable<Envelope["actions"]> {
  const t = s.trim();
  if (t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      throw new ApiError("invalid_message", "invalid X-Actions JSON");
    }
  }
  return t.split(";").map((part) => {
    const fields = part.split(",").map((f) => f.trim());
    const [action, label, url, ...rest] = fields;
    if (!action || !label || !["view", "http", "broadcast"].includes(action)) throw new ApiError("invalid_message", "invalid X-Actions");
    const a: Record<string, unknown> = { action, label };
    if (url) a.url = url;
    for (const kv of rest) {
      const [k, v] = kv.split("=", 2);
      if (k && v !== undefined) a[k] = v === "true" ? true : v === "false" ? false : v;
    }
    return a as NonNullable<Envelope["actions"]>[number];
  });
}

/** Publish via POST / with a JSON body (ntfy JSON publishing, plus full envelopes). */
export async function parseJsonPublish(req: Request): Promise<ParsedPublish> {
  const url = new URL(req.url);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError("bad_request", "body must be JSON");
  }
  if (typeof body !== "object" || body === null) throw new ApiError("bad_request", "body must be a JSON object");
  // ntfy JSON uses string priority names sometimes, and "attach"/"filename".
  const env = { ...body } as Envelope;
  if (typeof body.priority === "string") env.priority = parsePriority(body.priority as string);
  if (env.priority === 3) delete env.priority;
  if (typeof body.attach === "string") {
    env.attachment = { name: (body.filename as string) ?? (body.attach as string).split("/").pop() ?? "file", url: body.attach as string };
    delete env.attach;
    delete env.filename;
  }
  if (typeof body.markdown === "boolean") {
    if (body.markdown) env.content_type = "text/markdown";
    delete env.markdown;
  }
  if (body.delay !== undefined) throw new ApiError("unsupported", "scheduled delivery is not supported in v0");
  return { envelope: env, route: parseRoute(req, url, env), dryRun: ["1", "true"].includes((req.headers.get("x-dry-run") ?? "").toLowerCase()), idempotencyKey: req.headers.get("idempotency-key") };
}

export function parseFilter(url: URL): SubscriptionFilter {
  const f: SubscriptionFilter = {};
  const p = url.searchParams.get("priority") ?? url.searchParams.get("prio") ?? url.searchParams.get("p");
  if (p) f.priority = p.split(",").map((x) => parsePriority(x)!).filter(Boolean);
  const t = url.searchParams.get("tags") ?? url.searchParams.get("tag") ?? url.searchParams.get("ta");
  if (t) f.tags = t.split(",").map((s) => s.trim()).filter(Boolean);
  return f;
}

export function isTopicName(s: string) {
  return isTopic(s);
}
