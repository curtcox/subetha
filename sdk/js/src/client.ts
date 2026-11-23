// SubEtha client: publish / subscribe over whatever works. Dependency-free; runs in browsers,
// Node ≥ 18, Deno, Bun, and Workers.
import {
  base64urlEncode, decryptEnvelope, Deduper, utf8, encryptEnvelope, signEnvelope, signRequestV2, ulid, unwrapTopicKey, verifyEnvelope, wrapTopicKey,
  type DeviceKey, type Envelope, type RouteMode, type Transport, type WrappedKey,
} from "./protocol/index.ts";

export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  /** Sign every publish with this device key (spec §4). Shorthand for `signer: webCryptoSigner(deviceKey)`. */
  deviceKey?: DeviceKey;
  /**
   * Signs publishes and (with signRequests) requests as a device, in place of `deviceKey`. For
   * runtimes without WebCrypto Ed25519, e.g. React Native with the Rust core.
   */
  signer?: DeviceSigner;
  /** Checks envelope signatures for subscribe's `verify`/`requireSignature`. Default: WebCrypto Ed25519. */
  verifyEnvelope?: (env: Envelope) => boolean | Promise<boolean>;
  /** E2EE keys by topic (spec §5). Messages to these topics are encrypted, and received ones decrypted. */
  topicKeys?: Record<string, { kid: string; key: Uint8Array }>;
  WebSocket?: typeof WebSocket;
  /** Authenticate every request with a device signature (enrolled devices; see /v1/device/code). */
  signRequests?: boolean;
}

/** Opens wrapped topic keys (spec §5.1) addressed to `deviceId`; null when it can't. */
export interface KeyUnwrapper {
  deviceId: string;
  unwrap(w: WrappedKey): Uint8Array | null | Promise<Uint8Array | null>;
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
  /** Deliver envelopes exactly as the relay sent them (no decryption), e.g. to forward them. */
  raw?: boolean;
  onOpen?: () => void;
  onError?: (e: Error) => void;
  signal?: AbortSignal;
}

export interface Subscription { close(): void; readonly closed: boolean }

/**
 * X-Device-* headers for a device-signed request (spec §8.1, `subetha-req-v2`). Pass the headers
 * the request will carry: content and routing headers must be signed.
 */
/**
 * Signs as a device: envelopes (spec §4) and requests (spec §8.1). `webCryptoSigner(key)` is
 * what `deviceKey` uses; React Native passes one backed by the Rust core (`coreSigner`).
 */
export interface DeviceSigner {
  readonly deviceId: string;
  /** A copy of `env` (which carries id and time) with `sender` and `sig` set. */
  signEnvelope(env: Envelope): Envelope | Promise<Envelope>;
  /** The X-Device-* headers for a request that carries `headers` (see signRequest). */
  signRequest(method: string, url: string, body: Uint8Array, headers: Iterable<[string, string]>, nowSec: number): Record<string, string> | Promise<Record<string, string>>;
}

/** A DeviceSigner over WebCrypto Ed25519. */
export function webCryptoSigner(key: DeviceKey): DeviceSigner {
  return {
    deviceId: key.deviceId,
    signEnvelope: (env) => signEnvelope(env, key),
    signRequest: (method, url, body, headers, nowSec) => signRequestV2(key, method, url, body, headers, nowSec),
  };
}

export function signRequest(key: DeviceKey, method: string, url: string, body: Uint8Array, headers: Record<string, string> | Iterable<[string, string]> = {}, nowSec = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  return signRequestV2(key, method, url, body, headers, nowSec);
}

function headersEntries(h: Headers): [string, string][] {
  const out: [string, string][] = [];
  h.forEach((v: string, k: string) => out.push([k, v]));
  return out;
}

function bodyBytes(body: RequestInit["body"]): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return utf8.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("signed requests need a string or byte body");
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
  private readonly signer?: DeviceSigner;
  private readonly deviceKey?: DeviceKey;
  private readonly verify: (env: Envelope) => boolean | Promise<boolean>;
  private readonly topicKeys: Record<string, { kid: string; key: Uint8Array }>;
  private readonly WS?: typeof WebSocket;
  private readonly signRequests: boolean;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://subetha.us").replace(/\/+$/, "");
    this.token = opts.token;
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.signer = opts.signer ?? (opts.deviceKey ? webCryptoSigner(opts.deviceKey) : undefined);
    this.deviceKey = opts.deviceKey;
    this.verify = opts.verifyEnvelope ?? ((env) => verifyEnvelope(env));
    this.topicKeys = opts.topicKeys ?? {};
    this.WS = opts.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    this.signRequests = !!opts.signRequests;
    if (this.signRequests && !this.signer) throw new Error("signRequests needs a deviceKey or signer");
    if (this.signRequests) {
      const inner = this.f;
      this.f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = bodyBytes(init.body);
        const headers = new Headers(init.headers);
        headers.delete("authorization");
        // fetch adds text/plain for string bodies; set it here so it's signed.
        if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
        const signed = await this.signer!.signRequest(init.method ?? "GET", url, body, [...headersEntries(headers)], Math.floor(Date.now() / 1000));
        for (const [k, v] of Object.entries(signed)) headers.set(k, v);
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
    const sign = o.sign ?? !!this.signer;
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
      if (!this.signer) throw new Error("sign requested but no deviceKey or signer configured");
      env = await this.signer.signEnvelope(env);
    }
    return env;
  }

  /** Publish a message. Returns the stored envelope (as the relay saw it). */
  async publish(topic: string, message: string, o: PublishOptions = {}): Promise<Envelope> {
    const env = await this.buildEnvelope(topic, message, o);
    return this.request<Envelope>("POST", "/", env, o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {});
  }

  /**
   * Publish an envelope exactly as given: one built elsewhere, or received over an edge link and
   * forwarded (signatures and E2EE stay intact; the relay drops it as a duplicate by id).
   */
  async publishEnvelope(env: Envelope, o: { idempotencyKey?: string } = {}): Promise<Envelope> {
    const { event: _event, ...rest } = env;
    return this.request<Envelope>("POST", "/", rest, o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {});
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
        if (raw.sig ? !(await this.verify(raw)) : o.requireSignature) return;
      }
      const m = o.raw ? raw : await this.receive(raw);
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
  /**
   * Wraps a topic key for each device (spec §5.1) and uploads the wrapped keys (PUT /v1/keys).
   * The relay stores them but can't read them. Needs an admin token for a topic you own.
   */
  async shareTopicKey(topic: string, kid: string, key: Uint8Array, deviceIds: string[]): Promise<{ stored: number }> {
    const wrapped = await Promise.all(deviceIds.map((to) => wrapTopicKey(key, { topic, kid, to })));
    let stored = 0;
    for (let i = 0; i < wrapped.length; i += 100) {
      stored += (await this.request<{ stored: number }>("PUT", "/v1/keys", { keys: wrapped.slice(i, i + 100) })).stored;
    }
    return { stored };
  }

  /** Wrapped keys: as a device, the ones addressed to it; as an admin, all of your topics' (GET /v1/keys). */
  listWrappedKeys(topic?: string) {
    return this.request<{ keys: (WrappedKey & { created_at: number })[] }>("GET", `/v1/keys${topic ? `?topic=${encodeURIComponent(topic)}` : ""}`);
  }

  /** Deletes wrapped keys for a topic, optionally only one kid and/or one device. */
  deleteWrappedKeys(topic: string, o: { kid?: string; device?: string } = {}) {
    const q = new URLSearchParams({ topic, ...(o.kid ? { kid: o.kid } : {}), ...(o.device ? { device: o.device } : {}) });
    return this.request<{ deleted: number }>("DELETE", `/v1/keys?${q}`);
  }

  /**
   * Fetches the wrapped keys addressed to this device, opens them with its device key, and uses
   * them for E2EE from then on (the newest key per topic wins). Needs `signRequests` (or a token
   * for the device's account plus `deviceKey`). Pass `unwrapper` where WebCrypto X25519 is
   * missing (React Native: `coreKeyUnwrapper` from @subetha/react-native). Returns the topics
   * whose keys were loaded.
   */
  async loadTopicKeys(o: { topic?: string; deviceKey?: DeviceKey; unwrapper?: KeyUnwrapper } = {}): Promise<Record<string, { kid: string; key: Uint8Array }>> {
    const dk = o.deviceKey ?? this.deviceKey;
    const unwrapper: KeyUnwrapper | undefined = o.unwrapper ?? (dk ? { deviceId: dk.deviceId, unwrap: (w) => unwrapTopicKey(w, dk) } : undefined);
    if (!unwrapper) throw new Error("loadTopicKeys needs a deviceKey or an unwrapper");
    const { keys } = await this.listWrappedKeys(o.topic);
    const loaded: Record<string, { kid: string; key: Uint8Array; at: number }> = {};
    for (const w of keys) {
      if (w.to !== unwrapper.deviceId) continue;
      const { created_at: at, ...wrapped } = w;
      const key = await unwrapper.unwrap(wrapped);
      if (key && (!loaded[w.topic] || at >= loaded[w.topic]!.at)) loaded[w.topic] = { kid: w.kid, key, at };
    }
    const out: Record<string, { kid: string; key: Uint8Array }> = {};
    for (const [t, { kid, key }] of Object.entries(loaded)) out[t] = this.topicKeys[t] = { kid, key };
    return out;
  }

  /** The HTML receipt for one payment (GET /v1/payments/{id}/receipt). */
  async receipt(id: string): Promise<string> {
    const r = await this.f(`${this.baseUrl}/v1/payments/${encodeURIComponent(id)}/receipt`, { headers: this.headers() });
    const text = await r.text();
    if (!r.ok) throw new SubEthaError(r.status, (() => { try { return JSON.parse(text); } catch { return { message: text }; } })());
    return text;
  }
  payments(limit = 50) { return this.request<{ payments: { id: string; kind: "checkout" | "auto_recharge"; amount_micros: number; fee_micros: number; credit_micros: number; refunded_micros: number; disputed: boolean; created_at: number }[] }>("GET", `/v1/payments?limit=${limit}`); }
  prices() { return this.request<Record<string, unknown>>("GET", "/v1/prices"); }
  createToken(body: { name?: string; scopes: string[]; transports?: Transport[]; daily_cap_usd?: number; total_cap_usd?: number; origins?: string[]; ips?: string[]; expires_in_s?: number }) {
    return this.request<{ id: string; token: string; scopes: string[] }>("POST", "/v1/tokens", body);
  }
  listTokens() { return this.request<{ tokens: unknown[] }>("GET", "/v1/tokens"); }
  revokeToken(id: string) { return this.request("DELETE", `/v1/tokens/${encodeURIComponent(id)}`); }
  topics() { return this.request<{ topics: { name: string; policy: Record<string, unknown> }[] }>("GET", "/v1/topics"); }
  configureTopic(topic: string, policy: Record<string, unknown>) { return this.request("PUT", `/v1/topics/${topic}`, { policy }); }
  trace(topic: string, id: string) { return this.request<Record<string, unknown>>("GET", `/v1/traces/${id}?topic=${encodeURIComponent(topic)}`); }
  checkout(amountUsd: number) { return this.request<{ url: string }>("POST", "/v1/billing/checkout", { amount_usd: amountUsd }); }
}
