// SubEtha client: publish / subscribe over whatever works. Dependency-free; runs in browsers,
// Node ≥ 18, Deno, Bun, and Workers.
import {
  base64urlEncode, decryptEnvelope, Deduper, hexEncode, utf8, encryptEnvelope, signEnvelope, ulid, verifyEnvelope,
  type DeviceKey, type Envelope, type RouteMode, type Transport,
} from "./protocol/index.ts";

export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  /** Sign every publish with this device key (spec §4). */
  deviceKey?: DeviceKey;
  /** E2EE keys by topic (spec §5). Messages to these topics are encrypted, and received ones decrypted. */
  topicKeys?: Record<string, { kid: string; key: Uint8Array }>;
  WebSocket?: typeof WebSocket;
  /** Authenticate every request with a device signature (enrolled devices; see /v1/device/code). */
  signRequests?: boolean;
}

export interface PublishOptions {
  title?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  click?: string;
  icon?: string;
  actions?: Envelope["actions"];
  attachment?: Envelope["attachment"];
  contentType?: Envelope["content_type"];
  expires?: number;
  hops?: number;
  route?: { mode?: RouteMode; maxCostUsd?: number; deny?: Transport[]; allow?: Transport[]; deadlineS?: number };
  idempotencyKey?: string;
  sign?: boolean;
  encrypt?: boolean;
}

export interface Estimate { dry_run: true; estimate_usd_micros: number; plan: unknown[]; message: Envelope }

export interface SubscribeOptions {
  since?: string;
  priority?: number[];
  tags?: string[];
  /** "auto" picks WebSocket when available, else a JSON stream; "poll" polls every pollIntervalMs. */
  transport?: "auto" | "ws" | "stream" | "poll";
  pollIntervalMs?: number;
  /** Ack every received message (enables escalation to stop). Default true. */
  autoAck?: boolean;
  /** Drop messages whose signatures fail; unsigned messages pass unless requireSignature. */
  verify?: boolean;
  requireSignature?: boolean;
  onOpen?: () => void;
  onError?: (e: Error) => void;
  signal?: AbortSignal;
}

export interface Subscription { close(): void; readonly closed: boolean }

/** Headers for a device-signed request (X-Device-Id / -Time / -Nonce / -Signature). */
export async function signRequest(key: DeviceKey, method: string, url: string, body: Uint8Array, nowSec = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  const u = new URL(url);
  const digest = hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource)));
  const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const input = `subetha-req-v1\n${method.toUpperCase()}\n${u.host}\n${u.pathname}${u.search}\n${nowSec}\n${nonce}\n${digest}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8.encode(input) as BufferSource));
  return { "x-device-id": key.deviceId, "x-device-time": String(nowSec), "x-device-nonce": nonce, "x-device-signature": base64urlEncode(sig) };
}

/** Proof of key possession for POST /v1/device/code. */
export async function enrollmentProof(key: DeviceKey, nowSec = Math.floor(Date.now() / 1000)): Promise<{ device_id: string; time: number; proof: string }> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8.encode(`subetha-enroll-v1\n${key.deviceId}\n${nowSec}`) as BufferSource));
  return { device_id: key.deviceId, time: nowSec, proof: base64urlEncode(sig) };
}

export class SubEthaError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.error ?? `HTTP ${status}`));
    this.code = String(body.error ?? "http_error");
    this.status = status;
    this.body = body;
  }
}

const topicPath = (topics: string | string[]) => (Array.isArray(topics) ? topics : [topics]).map((t) => t.split("/").map(encodeURIComponent).join("/")).join(",");

export class SubEtha {
  readonly baseUrl: string;
  private readonly token?: string;
  private f: typeof fetch;
  private readonly deviceKey?: DeviceKey;
  private readonly topicKeys: Record<string, { kid: string; key: Uint8Array }>;
  private readonly WS?: typeof WebSocket;
  private readonly signRequests: boolean;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://subetha.org").replace(/\/+$/, "");
    this.token = opts.token;
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.deviceKey = opts.deviceKey;
    this.topicKeys = opts.topicKeys ?? {};
    this.WS = opts.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    this.signRequests = !!opts.signRequests;
    if (this.signRequests && !this.deviceKey) throw new Error("signRequests needs a deviceKey");
    if (this.signRequests) {
      const inner = this.f;
      this.f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = typeof init.body === "string" ? utf8.encode(init.body) : new Uint8Array();
        const headers = new Headers(init.headers);
        for (const [k, v] of Object.entries(await signRequest(this.deviceKey!, init.method ?? "GET", url, body))) headers.set(k, v);
        headers.delete("authorization");
        return inner(input, { ...init, headers });
      }) as typeof fetch;
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const r = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined ? { "content-type": "application/json", ...headers } : headers),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
    if (!r.ok) throw new SubEthaError(r.status, data);
    return data as T;
  }

  /** Build the envelope that publish() would send (signed/encrypted as configured). */
  async buildEnvelope(topic: string, message: string, o: PublishOptions = {}): Promise<Envelope> {
    let env: Envelope = { topic, message };
    if (o.title !== undefined) env.title = o.title;
    if (o.priority !== undefined && o.priority !== 3) env.priority = o.priority;
    if (o.tags?.length) env.tags = o.tags;
    if (o.click) env.click = o.click;
    if (o.icon) env.icon = o.icon;
    if (o.actions) env.actions = o.actions;
    if (o.attachment) env.attachment = o.attachment;
    if (o.contentType) env.content_type = o.contentType;
    if (o.expires) env.expires = o.expires;
    if (o.hops !== undefined) env.hops = o.hops;
    if (o.route) {
      env.route = {};
      if (o.route.mode) env.route.mode = o.route.mode;
      if (o.route.maxCostUsd !== undefined) env.route.max_cost_usd_micros = Math.floor(o.route.maxCostUsd * 1e6);
      if (o.route.deny) env.route.deny = o.route.deny;
      if (o.route.allow) env.route.allow = o.route.allow;
      if (o.route.deadlineS) env.route.deadline_s = o.route.deadlineS;
    }
    const tk = this.topicKeys[topic];
    const sign = o.sign ?? !!this.deviceKey;
    const encrypt = o.encrypt ?? !!tk;
    if (sign || encrypt) {
      env.id = ulid();
      env.time = Math.floor(Date.now() / 1000);
    }
    if (encrypt) {
      if (!tk) throw new Error(`no E2EE key for ${topic}`);
      env = await encryptEnvelope(env, tk.key, tk.kid);
    }
    if (sign) {
      if (!this.deviceKey) throw new Error("sign requested but no deviceKey configured");
      env = await signEnvelope(env, this.deviceKey);
    }
    return env;
  }

  /** Publish a message. Returns the stored envelope (as the relay saw it). */
  async publish(topic: string, message: string, o: PublishOptions = {}): Promise<Envelope> {
    const env = await this.buildEnvelope(topic, message, o);
    return this.request<Envelope>("POST", "/", env, o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {});
  }

  /** Dry run: route plan and cost estimate, nothing delivered (charged as one API request). */
  async estimate(topic: string, message: string, o: PublishOptions = {}): Promise<Estimate> {
    const env = await this.buildEnvelope(topic, message, o);
    return this.request<Estimate>("POST", "/", env, { "x-dry-run": "1" });
  }

  private query(o: { since?: string; priority?: number[]; tags?: string[]; poll?: boolean }): string {
    const q = new URLSearchParams();
    if (o.poll) q.set("poll", "1");
    if (o.since) q.set("since", o.since);
    if (o.priority?.length) q.set("priority", o.priority.join(","));
    if (o.tags?.length) q.set("tags", o.tags.join(","));
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  /** Cached messages (since defaults to "all"). */
  async poll(topics: string | string[], o: { since?: string; priority?: number[]; tags?: string[] } = {}): Promise<Envelope[]> {
    const r = await this.f(`${this.baseUrl}/${topicPath(topics)}/json${this.query({ ...o, since: o.since ?? "all", poll: true })}`, { headers: this.headers() });
    const text = await r.text();
    if (!r.ok) throw new SubEthaError(r.status, (() => { try { return JSON.parse(text); } catch { return { message: text }; } })());
    const out: Envelope[] = [];
    for (const line of text.split("\n")) if (line.trim()) out.push(await this.receive(JSON.parse(line)));
    return out;
  }

  private async receive(env: Envelope): Promise<Envelope> {
    if (env.enc && this.topicKeys[env.topic]) {
      const dec = await decryptEnvelope(env, this.topicKeys[env.topic]!.key);
      if (dec) return dec;
    }
    return env;
  }

  async ack(topic: string, id: string, via = "http"): Promise<void> {
    await this.request("POST", "/v1/ack", { topic, id, via });
  }

  /**
   * Subscribe with automatic reconnect (resuming from the last id), dedupe across transports,
   * decryption, optional signature checks, and acks.
   */
  subscribe(topics: string | string[], onMessage: (m: Envelope) => void | Promise<void>, o: SubscribeOptions = {}): Subscription {
    const dedupe = new Deduper();
    let since = o.since;
    let closed = false;
    let ws: WebSocket | null = null;
    let abort: AbortController | null = null;
    let backoff = 500;
    const list = Array.isArray(topics) ? topics : [topics];
    const mode = o.transport === undefined || o.transport === "auto" ? (this.WS && list.length === 1 && !this.signRequests ? "ws" : "stream") : o.transport;

    const deliver = async (raw: Envelope) => {
      if (raw.event && raw.event !== "message") {
        if (raw.event === "open") { backoff = 500; o.onOpen?.(); }
        return;
      }
      if (!dedupe.accept(raw)) return;
      if (raw.id) since = raw.id;
      if (o.verify || o.requireSignature) {
        if (raw.sig ? !(await verifyEnvelope(raw)) : o.requireSignature) return;
      }
      const m = await this.receive(raw);
      await onMessage(m);
      if (o.autoAck !== false && m.id) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ event: "ack", id: m.id }));
        else this.ack(m.topic, m.id, mode).catch(() => {});
      }
    };

    const fail = (e: unknown) => {
      if (closed) return;
      o.onError?.(e instanceof Error ? e : new Error(String(e)));
      setTimeout(run, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };

    const run = async () => {
      if (closed) return;
      const q = this.query({ since, priority: o.priority, tags: o.tags });
      if (mode === "ws") {
        const url = new URL(`${this.baseUrl}/${topicPath(list)}/ws${q}`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        if (this.token) url.searchParams.set("auth", btoa(`Bearer ${this.token}`).replace(/=+$/, ""));
        ws = new this.WS!(url.toString());
        ws.addEventListener("message", (e: MessageEvent) => void deliver(JSON.parse(String(e.data))).catch((err) => o.onError?.(err)));
        ws.addEventListener("close", () => { ws = null; if (!closed) fail(new Error("websocket closed")); });
        ws.addEventListener("error", () => {});
        return;
      }
      if (mode === "poll") {
        try {
          for (const m of await this.poll(list, { since: since ?? "all", priority: o.priority, tags: o.tags })) await deliver(m);
          since ??= String(Math.floor(Date.now() / 1000));
          setTimeout(run, o.pollIntervalMs ?? 5000);
        } catch (e) {
          fail(e);
        }
        return;
      }
      abort = new AbortController();
      try {
        const r = await this.f(`${this.baseUrl}/${topicPath(list)}/json${q}`, { headers: this.headers(), signal: abort.signal });
        if (!r.ok || !r.body) throw new SubEthaError(r.status, (await r.json().catch(() => ({}))) as Record<string, unknown>);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) await deliver(JSON.parse(line));
          }
        }
        fail(new Error("stream ended"));
      } catch (e) {
        if (!closed) fail(e);
      }
    };

    o.signal?.addEventListener("abort", () => sub.close());
    void run();
    const sub: Subscription = {
      close() {
        closed = true;
        ws?.close();
        abort?.abort();
      },
      get closed() { return closed; },
    };
    return sub;
  }

  // ---- control plane ----
  account() { return this.request<{ id: string; handle: string | null; balance_usd_micros: number; tier: string }>("GET", "/v1/account"); }
  balance() { return this.request<{ available_usd_micros: number; reserved_usd_micros: number }>("GET", "/v1/balance"); }
  ledger(after = 0) { return this.request<{ entries: unknown[] }>("GET", `/v1/ledger?after=${after}`); }
  prices() { return this.request<Record<string, unknown>>("GET", "/v1/prices"); }
  createToken(body: { name?: string; scopes: string[]; transports?: Transport[]; daily_cap_usd?: number; total_cap_usd?: number; origins?: string[]; expires_in_s?: number }) {
    return this.request<{ id: string; token: string; scopes: string[] }>("POST", "/v1/tokens", body);
  }
  listTokens() { return this.request<{ tokens: unknown[] }>("GET", "/v1/tokens"); }
  revokeToken(id: string) { return this.request("DELETE", `/v1/tokens/${encodeURIComponent(id)}`); }
  topics() { return this.request<{ topics: { name: string; policy: Record<string, unknown> }[] }>("GET", "/v1/topics"); }
  configureTopic(topic: string, policy: Record<string, unknown>) { return this.request("PUT", `/v1/topics/${topic}`, { policy }); }
  trace(topic: string, id: string) { return this.request<Record<string, unknown>>("GET", `/v1/traces/${id}?topic=${encodeURIComponent(topic)}`); }
  checkout(amountUsd: number) { return this.request<{ url: string }>("POST", "/v1/billing/checkout", { amount_usd: amountUsd }); }
}
