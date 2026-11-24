// HTTP/1.1 → HTTP/2 relay for Apple Push Notifications (PLAN §6, APNs).
//
// APNs only speaks HTTP/2 and a Cloudflare Worker's fetch() can't be relied on to negotiate it,
// so the relay Worker (workers/api/src/delivery/apns.ts) can send to this service instead
// (APNS_ENDPOINT). It forwards `POST /3/device/{token}` to APNs over one long-lived HTTP/2
// connection, headers and body unchanged, and returns APNs' status, `apns-id`, and body.
//
// It holds no Apple credentials: the Worker signs the provider token and sends it in
// `authorization`. A shared secret (`x-relay-secret`, RELAY_SECRET) keeps it from being an open
// relay. Zero dependencies; Node 22.18+ runs this file directly.
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

export const DEFAULT_UPSTREAM = "https://api.push.apple.com";
export const MAX_BODY = 5 * 1024; // APNs payloads are at most 4 KB
const DEVICE_PATH = /^\/3\/device\/([0-9a-fA-F]{32,200})$/;
const FORWARD = ["authorization", "apns-topic", "apns-push-type", "apns-priority", "apns-expiration", "apns-collapse-id", "apns-id", "content-type"];

export interface RelayOptions {
  secret: string;
  upstream?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const secretOk = (given: string | string[] | undefined, secret: string) => typeof given === "string" && timingSafeEqual(digest(given), digest(secret));

/** One shared HTTP/2 session per upstream, re-created when it closes, errors, or gets GOAWAY. */
class Upstream {
  private session: ClientHttp2Session | null = null;
  private readonly url: string;
  private readonly log: (m: string) => void;
  constructor(url: string, log: (m: string) => void) {
    this.url = url;
    this.log = log;
  }
  get(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const s = connect(this.url);
    s.on("error", (e) => {
      this.log(`upstream error: ${e.message}`);
      if (this.session === s) this.session = null;
    });
    s.on("goaway", () => { if (this.session === s) this.session = null; });
    s.on("close", () => { if (this.session === s) this.session = null; });
    s.setTimeout(60 * 60_000, () => s.close()); // idle for an hour: let it go
    this.session = s;
    return s;
  }
  close() { this.session?.close(); this.session = null; }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createRelay(opts: RelayOptions): Server & { closeUpstream(): void } {
  if (!opts.secret || opts.secret.length < 16) throw new Error("RELAY_SECRET must be at least 16 characters");
  const log = opts.log ?? ((m: string) => console.log(m));
  const upstream = new Upstream(opts.upstream ?? DEFAULT_UPSTREAM, log);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0]!;
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
      if (!secretOk(req.headers["x-relay-secret"], opts.secret)) return send(res, 401, { reason: "RelayUnauthorized" });
      const m = DEVICE_PATH.exec(path);
      if (!m) return send(res, 404, { reason: "BadPath" });
      if (req.method !== "POST") return send(res, 405, { reason: "MethodNotAllowed" }, { allow: "POST" });
      const body = await readBody(req);
      if (!body) return send(res, 413, { reason: "PayloadTooLarge" });

      const headers: Record<string, string> = { [constants.HTTP2_HEADER_METHOD]: "POST", [constants.HTTP2_HEADER_PATH]: `/3/device/${m[1]}` };
      for (const h of FORWARD) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      const result = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
        const stream = upstream.get().request(headers);
        const timer = setTimeout(() => { stream.close(constants.NGHTTP2_CANCEL); reject(new Error("timeout")); }, timeoutMs);
        let status = 502;
        const out: Record<string, string> = {};
        const chunks: Buffer[] = [];
        stream.on("response", (h) => {
          status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 502);
          if (typeof h["apns-id"] === "string") out["apns-id"] = h["apns-id"];
          if (typeof h["apns-unique-id"] === "string") out["apns-unique-id"] = h["apns-unique-id"];
        });
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => { clearTimeout(timer); resolve({ status, headers: out, body: Buffer.concat(chunks) }); });
        stream.on("error", (e) => { clearTimeout(timer); reject(e); });
        stream.end(body);
      });
      res.writeHead(result.status, { ...result.headers, ...(result.body.length ? { "content-type": "application/json" } : {}), "content-length": result.body.length });
      res.end(result.body);
      if (result.status >= 400) log(`apns ${result.status} ${result.body.toString().slice(0, 200)}`);
    } catch (e) {
      const timeout = (e as Error).message === "timeout";
      log(`relay ${timeout ? "timeout" : "error"}: ${(e as Error).message}`);
      if (!res.headersSent) send(res, timeout ? 504 : 502, { reason: timeout ? "UpstreamTimeout" : "UpstreamUnavailable" });
    }
  });
  server.on("close", () => upstream.close());
  return Object.assign(server, { closeUpstream: () => upstream.close() });
}
