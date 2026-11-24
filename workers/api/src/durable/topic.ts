// TopicDO: one per topic. Stores recent messages, holds live connections (WebSocket hibernation
// plus SSE / JSON / raw streams), plans fan-out, and pays for it from credit leases taken from the
// owner's AccountDO (PLAN §5, §7).
import { DurableObject } from "cloudflare:workers";
import { ulid, verifyEnvelope, type Envelope, type Transport } from "@subetha/sdk/protocol";
import { actionPriceMicros, rentNanos, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { asResult, rpcError, type RpcResult } from "../errors.ts";
import { planDeliveries, transportAllowed } from "../routing.ts";
import { mmsMedia, smsBody, smsSegments, voiceMinutes } from "../delivery/twilio.ts";
import { renderText } from "../delivery/senders.ts";
import { DEST_PRICES_KEY, destUnitPrice, type DestinationPrices } from "../delivery/destinations.ts";
import type { Caller, DeliveryJob, Env, PublishInput, PublishResult, QueuedSubscription, SubscriptionFilter, TopicMeta } from "../types.ts";
import { accountStub } from "./account.ts";
import { emitMetric, estimatedCostMicros } from "../telemetry.ts";

const PRICES = prices as unknown as PriceTable;
const LEASE_MICROS = 10_000; // 1¢
const LEASE_IDLE_MS = 60_000;
const DEFAULT_RETENTION_S = 12 * 3600;
const MAX_RETENTION_S = 30 * 86400;
const ALARM_MS = 60_000;
const KEEPALIVE_MS = 45_000;
const MAX_BACKLOG = 1000;
const MAX_CLOCK_SKEW_S = 300;
const MAX_MESSAGE_AGE_S = 7 * 86400;

interface Lease { ref: string; granted: number; remaining: number; at: number }
type StreamFormat = "json" | "sse" | "raw";
interface Stream { id: string; format: StreamFormat; filter: SubscriptionFilter; deviceId?: string | null; send: (b: Uint8Array) => void; close: () => void }
interface WsAttachment { id: string; filter: SubscriptionFilter; deviceId?: string | null }

export interface SubscribeParams {
  format: StreamFormat | "ws";
  since: string | null;
  filter: SubscriptionFilter;
  caller: Caller;
  poll: boolean;
  /** Optional transport override for policy/metering (e.g. "mcp" from the MCP worker). */
  transport?: "ws" | "sse" | "poll" | "mcp";
}

const enc = new TextEncoder();
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function matchesFilter(m: Envelope, f: SubscriptionFilter): boolean {
  if (f.priority?.length && !f.priority.includes(m.priority ?? 3)) return false;
  if (f.tags?.length && !f.tags.every((t) => m.tags?.includes(t))) return false;
  return true;
}

function idMatch(list: string[] | undefined, c: Caller): boolean {
  if (!list) return false;
  return [c.accountId, c.tokenId, c.deviceId].some((x) => x !== null && list.includes(x));
}

export class TopicDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private meta: TopicMeta | null = null;
  private accountTransports: { allow: Transport[] | null; deny: Transport[] | null } = { allow: null, deny: null };
  private accountPaused = false;
  private leases: Lease[] = [];
  private nanoDebt = 0;
  private readonly streams = new Map<string, Stream>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private anonWindow = { minute: 0, count: 0 };
  private rateBucket: { tokens: number; at: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, time INTEGER NOT NULL, expires INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idem (key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, message_id TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS acks (id TEXT PRIMARY KEY, time INTEGER NOT NULL, via TEXT);
      CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, json TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sent (ref TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, until INTEGER NOT NULL);`);
    ctx.blockConcurrencyWhile(async () => {
      this.meta = this.kvGet<TopicMeta>("meta");
      this.accountTransports = this.kvGet<{ allow: Transport[] | null; deny: Transport[] | null }>("account_transports") ?? { allow: null, deny: null };
      this.accountPaused = this.kvGet<boolean>("account_paused") ?? false;
      this.leases = this.kvGet<Lease[]>("leases") ?? [];
      this.nanoDebt = this.kvGet<number>("nano_debt") ?? 0;
    });
  }

  // ---------- small storage helpers ----------
  private kvGet<T>(k: string): T | null {
    const r = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return r ? (JSON.parse(r.v) as T) : null;
  }
  private kvPut(k: string, v: unknown) {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }
  /** Adds to a numeric kv counter synchronously (no await between read and write). */
  private bump(k: string, delta: number) {
    this.kvPut(k, Math.max(0, (this.kvGet<number>(k) ?? 0) + delta));
  }
  private persistMoney() {
    this.kvPut("leases", this.leases);
    this.kvPut("nano_debt", this.nanoDebt);
  }
  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  // ---------- configuration ----------
  async configure(meta: TopicMeta, accountTransports?: { allow: Transport[] | null; deny: Transport[] | null }): Promise<void> {
    if (this.meta?.policy.rate_per_min !== meta.policy.rate_per_min || this.meta?.policy.burst !== meta.policy.burst) {
      this.rateBucket = null;
    }
    this.meta = meta;
    this.kvPut("meta", meta);
    if (accountTransports) {
      this.accountTransports = accountTransports;
      this.kvPut("account_transports", accountTransports);
    }
    if (meta.policy.paused) this.closeAll(4403, "topic paused");
  }

  /** Tears down a deleted topic: closes live connections, returns credit leases, wipes state. */
  async destroy(): Promise<void> {
    this.closeAll(4404, "topic deleted");
    await this.returnLeases(true);
    this.meta = null;
    this.rateBucket = null;
    this.nanoDebt = 0;
    this.ctx.storage.transactionSync(() => {
      for (const tbl of ["messages", "idem", "acks", "subs", "traces", "kv", "sent", "seen"]) {
        this.sql.exec(`DELETE FROM ${tbl}`);
      }
    });
    await this.ctx.storage.deleteAlarm();
  }

  async setAccountTransports(allow: Transport[] | null, deny: Transport[] | null): Promise<void> {
    this.accountTransports = { allow, deny };
    this.kvPut("account_transports", this.accountTransports);
  }

  async setAccountPaused(paused: boolean): Promise<void> {
    this.accountPaused = paused;
    this.kvPut("account_paused", paused);
    if (paused) {
      this.closeAll(4403, "account paused");
      await this.returnLeases(true);
    }
  }

  async setTier(tier: string): Promise<void> {
    if (!this.meta) return;
    this.meta = { ...this.meta, tier };
    this.kvPut("meta", this.meta);
  }

  async getMeta(): Promise<TopicMeta | null> {
    return this.meta;
  }

  /** Aggregate subscriber counts for the topic owner (never reveals identities; PLAN §11). */
  async subscriberCounts(): Promise<{ live: number; queued: number }> {
    return { live: this.streams.size + this.ctx.getWebSockets().length, queued: this.queuedSubs().length };
  }

  async setSubscriptions(subs: QueuedSubscription[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM subs");
      for (const s of subs) this.sql.exec("INSERT INTO subs (id, json) VALUES (?, ?)", s.id, JSON.stringify(s));
    });
  }

  private queuedSubs(): QueuedSubscription[] {
    return this.sql.exec<{ json: string }>("SELECT json FROM subs").toArray().map((r) => JSON.parse(r.json));
  }

  private destCache: { at: number; prices: DestinationPrices | null } | null = null;
  /** Live per-country SMS/voice prices, re-read from KV at most every five minutes. */
  private async destPrices(): Promise<DestinationPrices | null> {
    if (!this.queuedSubs().some((s) => s.country)) return null;
    const now = Date.now();
    if (!this.destCache || now - this.destCache.at > 300_000) {
      this.destCache = { at: now, prices: await this.env.CACHE.get<DestinationPrices>(DEST_PRICES_KEY, "json") };
    }
    return this.destCache.prices;
  }

  private tier(): string {
    return (this.meta as TopicMeta & { tier?: string })?.tier ?? "standard";
  }

  // ---------- money ----------
  /** Read-side spend (polls, streams, backlog) also counts toward the topic's daily and monthly caps. */
  private async spendOwnerCapped(micros: number): Promise<"ok" | "cap_daily" | "cap_monthly" | "paused" | "account_daily" | "account_monthly" | "broke"> {
    const dailyCap = this.meta?.policy.daily_cap_micros;
    const monthlyCap = this.meta?.policy.monthly_cap_micros;
    const dayKey = `topic_spend:${today()}`;
    const monthKey = `topic_spend_month:${thisMonth()}`;
    const daySpent = this.kvGet<number>(dayKey) ?? 0;
    const monthSpent = this.kvGet<number>(monthKey) ?? 0;
    if (dailyCap != null && daySpent + micros > dailyCap) return "cap_daily";
    if (monthlyCap != null && monthSpent + micros > monthlyCap) return "cap_monthly";
    // Count it before awaiting, so concurrent requests can't all pass the same check.
    this.kvPut(dayKey, daySpent + micros);
    this.kvPut(monthKey, monthSpent + micros);
    const paid = await this.spendOwner(micros);
    if (paid !== "ok") {
      this.bump(dayKey, -micros);
      this.bump(monthKey, -micros);
      return paid;
    }
    return "ok";
  }

  /**
   * Token (and OAuth client) spend caps cover everything the token causes, reads included,
   * even though the topic owner pays for reads.
   */
  private async capTokenRead(caller: Caller, micros: number): Promise<boolean> {
    if (!caller.tokenId || !caller.accountId || (caller.caps.daily == null && caller.caps.total == null)) return false;
    const r = await accountStub(this.env, caller.accountId).trackTokenSpend(caller.tokenId, micros, { tokenDaily: caller.caps.daily, tokenTotal: caller.caps.total });
    if (!r.ok && r.code === "spend_cap_exceeded") throw rpcError("spend_cap_exceeded", `spend cap reached: ${r.cap}`, { cap: r.cap, remaining_usd_micros: r.remaining });
    return true;
  }

  private async refundTokenRead(caller: Caller, micros: number): Promise<void> {
    if (!caller.tokenId || !caller.accountId || micros <= 0) return;
    await accountStub(this.env, caller.accountId).refundTokenSpend(caller.tokenId, micros).catch(() => {});
  }

  private spendFailureError(reason: Exclude<Awaited<ReturnType<TopicDO["spendOwnerCapped"]>>, "ok">, anonymous = false): Error {
    if (reason === "paused") return rpcError("topic_paused", "account is paused");
    if (reason === "cap_daily") return rpcError("spend_cap_exceeded", "topic daily cap reached", { cap: "topic_daily" });
    if (reason === "cap_monthly") return rpcError("spend_cap_exceeded", "topic monthly cap reached", { cap: "topic_monthly" });
    if (reason === "account_daily" || reason === "account_monthly") return rpcError("spend_cap_exceeded", `spend cap reached: ${reason}`, { cap: reason });
    return rpcError(anonymous ? "no_funded_owner" : "insufficient_balance", "topic owner's balance cannot cover delivery", { payer: "topic_owner" });
  }

  /** Lease bookkeeping spans awaits (input gates stay open during RPC), so it is serialized. */
  private moneyLock: Promise<unknown> = Promise.resolve();
  private withMoney<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.moneyLock.then(fn, fn);
    this.moneyLock = run.catch(() => {});
    return run;
  }

  /** Spend µ$ from the owner's credit leases, taking a new lease if needed. */
  private spendOwner(micros: number, nanos = 0, ownerOverride?: string): Promise<"ok" | "paused" | "account_daily" | "account_monthly" | "broke"> {
    if (!Number.isSafeInteger(micros) || micros < 0 || !Number.isFinite(nanos) || nanos < 0) throw new Error(`invalid spend: ${micros} µ$ ${nanos} n$`);
    return this.withMoney(() => this.spendOwnerLocked(micros, Math.ceil(nanos), ownerOverride));
  }

  private async spendOwnerLocked(micros: number, nanos: number, ownerOverride?: string): Promise<"ok" | "paused" | "account_daily" | "account_monthly" | "broke"> {
    if (this.accountPaused) return "paused";
    this.nanoDebt += nanos;
    const fromNanos = Math.floor(this.nanoDebt / 1000);
    const total = micros + fromNanos;
    if (total === 0) {
      this.persistMoney();
      return "ok";
    }
    const have = this.leases.reduce((n, l) => n + l.remaining, 0);
    if (have < total) {
      const leased = await this.takeLease(total - have, ownerOverride);
      if (leased !== "ok") {
        this.nanoDebt -= nanos;
        return leased;
      }
    }
    let need = total;
    for (const l of this.leases) {
      const take = Math.min(l.remaining, need);
      l.remaining -= take;
      l.at = Date.now();
      need -= take;
      if (!need) break;
    }
    if (need !== 0) throw new Error(`lease accounting error: ${need} µ$ unpaid`);
    this.nanoDebt -= fromNanos * 1000;
    this.persistMoney();
    await this.ensureAlarm();
    return "ok";
  }

  /** Give back owner spend for an action that didn't happen (spread across leases, newest first). */
  private refundOwner(micros: number, nanos = 0) {
    let left = micros;
    for (let i = this.leases.length - 1; i >= 0 && left > 0; i--) {
      const l = this.leases[i]!;
      const back = Math.min(left, l.granted - l.remaining);
      l.remaining += back;
      left -= back;
    }
    this.nanoDebt -= Math.ceil(nanos);
    this.persistMoney();
  }

  private async takeLease(min: number, ownerOverride?: string): Promise<"ok" | "paused" | "account_daily" | "account_monthly" | "broke"> {
    const owner = ownerOverride ?? this.meta?.owner;
    const name = this.meta?.name ?? "new";
    if (!owner) return "broke";
    const ref = `lease:${name}:${ulid()}`;
    const r = await accountStub(this.env, owner).lease(min, Math.max(min, LEASE_MICROS), ref);
    if (r.granted === 0) {
      if (r.reason === "paused") return "paused";
      if (r.reason === "account_daily") return "account_daily";
      if (r.reason === "account_monthly") return "account_monthly";
      return "broke";
    }
    this.leases.push({ ref, granted: r.granted, remaining: r.granted, at: Date.now() });
    this.persistMoney();
    return "ok";
  }

  private returnLeases(all: boolean): Promise<void> {
    return this.withMoney(async () => {
      if (!this.meta) return;
      const now = Date.now();
      // Detach first, so nothing can spend from a lease while its return is in flight.
      const out = this.leases.filter((l) => all || now - l.at > LEASE_IDLE_MS || l.remaining === 0);
      this.leases = this.leases.filter((l) => !out.includes(l));
      this.persistMoney();
      for (const l of out) {
        try {
          await accountStub(this.env, this.meta.owner).returnLease(l.ref, l.remaining, `topic=${this.meta.name}`);
        } catch (e) {
          console.error("returnLease failed", e);
          this.leases.push(l);
          this.persistMoney();
        }
      }
    });
  }

  private async chargeCaller(caller: Caller, micros: number, ref: string): Promise<void> {
    if (!caller.accountId || micros === 0) return;
    const r = await accountStub(this.env, caller.accountId).charge(micros, ref, caller.tokenId, { tokenDaily: caller.caps.daily, tokenTotal: caller.caps.total });
    if (!r.ok) {
      if (r.code === "insufficient_balance") throw rpcError("insufficient_balance", undefined, { shortfall_usd_micros: r.shortfall });
      if (r.cap === "account_paused") throw rpcError("topic_paused", "account is paused");
      throw rpcError("spend_cap_exceeded", `spend cap reached: ${r.cap}`, { cap: r.cap, remaining_usd_micros: r.remaining });
    }
  }

  // ---------- permissions ----------
  private canPublish(c: Caller, m: TopicMeta = this.meta!): boolean {
    return c.accountId === m.owner || !!m.policy.public_publish || idMatch(m.policy.allowed_publishers, c);
  }

  private canRead(c: Caller): boolean {
    const m = this.meta!;
    return m.name.startsWith("t_") || c.accountId === m.owner || !!m.policy.public_read || idMatch(m.policy.allowed_readers, c);
  }

  // ---------- publish ----------
  async publish(input: PublishInput): Promise<RpcResult<PublishResult>> {
    return asResult(() => this.publishInner(input));
  }

  private async publishInner(input: PublishInput): Promise<PublishResult> {
    // Read before any check below: a KV read lets other requests interleave.
    const dest = await this.destPrices();
    const pendingCreate = !this.meta;
    let meta: TopicMeta;
    let effectiveTransports = this.accountTransports;
    let effectiveAccountPaused = this.accountPaused;
    if (pendingCreate) {
      if (!input.autoCreateOwner) throw rpcError("no_funded_owner", "topic has no owner; create it first");
      meta = { name: input.envelope.topic, owner: input.autoCreateOwner, policy: {}, created_at: Date.now(), tier: input.autoCreateTier ?? "standard" };
      if (input.autoCreateAccountTransports) effectiveTransports = input.autoCreateAccountTransports;
      if (input.autoCreateAccountPaused) effectiveAccountPaused = true;
    } else {
      meta = this.meta!;
    }
    const { caller } = input;
    if (effectiveAccountPaused) throw rpcError("topic_paused", "account is paused");
    if (meta.policy.paused) throw rpcError("topic_paused");

    // Signatures (spec §4).
    let env = { ...input.envelope };
    if (env.sig !== undefined || meta.policy.require_signature) {
      if (env.sig === undefined) throw rpcError("signature_required");
      if (!(await verifyEnvelope(env))) throw rpcError("bad_signature");
    }
    const signed = env.sig !== undefined;
    if (env.sender !== undefined && !signed) throw rpcError("invalid_message", "sender is only accepted on signed messages");
    const signer: Caller = signed ? { ...caller, deviceId: env.sender as string } : caller;
    if (!this.canPublish(signer, meta)) throw rpcError("forbidden", "not allowed to publish to this topic");
    const anonymous = caller.accountId === null;
    const tier = meta.tier ?? "standard";

    // Idempotency.
    if (input.idempotencyKey && !pendingCreate) {
      const row = this.sql.exec<{ body_hash: string; message_id: string }>("SELECT body_hash, message_id FROM idem WHERE key = ?", input.idempotencyKey).toArray()[0];
      if (row) {
        if (row.body_hash !== input.bodyHash) throw rpcError("conflict", "Idempotency-Key reused with a different request");
        const msg = this.messageById(row.message_id);
        if (msg) {
          // A replay is still an API request: charged, and rate limited when anonymous.
          const price = actionPriceMicros(PRICES, "api_request", tier);
          if (anonymous) {
            this.anonRateLimit(Date.now());
            const paid = await this.spendOwnerCapped(price);
            if (paid !== "ok") throw this.spendFailureError(paid, true);
          } else {
            await this.chargeCaller(caller, price, `idem:${row.message_id}:${ulid()}`);
          }
          return { message: msg, created_topic: false, duplicate: true, cost_micros: anonymous ? 0 : price, plan: [], dry_run: input.dryRun };
        }
      }
    }

    // Finalize the envelope. Times come from clients, so bound them: they drive retention charges.
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (env.time !== undefined && (env.time > nowSec + MAX_CLOCK_SKEW_S || env.time < nowSec - MAX_MESSAGE_AGE_S)) {
      throw rpcError("invalid_message", "time must be within 5 minutes in the future and 7 days in the past");
    }
    if (env.expires !== undefined && env.expires <= nowSec) throw rpcError("invalid_message", "message has already expired");
    const time = env.time ?? nowSec;
    const retention = Math.min(meta.policy.retention_s ?? DEFAULT_RETENTION_S, MAX_RETENTION_S);
    // Storage expiry: never longer than the topic's retention from now.
    const storeUntil = Math.min(env.expires ?? nowSec + retention, nowSec + retention);
    if (signed || env.enc) {
      // Signed or encrypted envelopes are delivered exactly as sent: any rewrite would break the
      // signature or the E2EE associated data (event is outside both).
      if (!env.id || env.time === undefined) throw rpcError("invalid_message", "signed and encrypted messages must carry id and time");
      env = { ...env, event: "message" };
    } else {
      env = { ...env, id: (env.id ?? ulid(nowMs)).toUpperCase(), time, event: "message", expires: storeUntil };
      if (env.priority === 3) delete env.priority;
    }

    const idKey = env.id!.toUpperCase();
    const apiPrice = actionPriceMicros(PRICES, "api_request", tier);
    // Signed messages are accepted for MAX_MESSAGE_AGE_S but stored only for the retention
    // period: remember their ids for the whole window so a captured one can't be replayed.
    if (!pendingCreate) {
      this.sql.exec("DELETE FROM seen WHERE until < ?", nowSec);
      if (signed && !this.messageById(idKey) && this.sql.exec("SELECT 1 FROM seen WHERE id = ?", idKey).toArray().length) {
        throw rpcError("conflict", "this signed message was already published");
      }
      const dup = this.messageById(idKey);
      if (dup) {
        if (anonymous) {
          this.anonRateLimit(nowMs);
          const paid = await this.spendOwnerCapped(apiPrice);
          if (paid !== "ok") throw this.spendFailureError(paid, true);
        } else {
          await this.chargeCaller(caller, apiPrice, `dup:${idKey}:${ulid()}`);
        }
        return { message: dup, created_topic: false, duplicate: true, cost_micros: anonymous ? 0 : apiPrice, plan: [], dry_run: input.dryRun, store_until: storeUntil };
      }
    }

    // Plan.
    const live = pendingCreate ? [] : this.liveSubscribers(env);
    const plan = planDeliveries({
      liveSubscribers: live,
      queued: pendingCreate ? [] : this.queuedSubs(),
      mode: input.route.mode,
      priority: env.priority ?? 3,
      allowLists: [input.route.allow, caller.transports, effectiveTransports.allow],
      denyLists: [input.route.deny, caller.denyTransports, effectiveTransports.deny],
      policy: meta.policy,
      maxCostMicros: input.route.maxCost,
      deadlineS: input.route.deadlineS ?? null,
      prices: PRICES,
      tier,
      nowMs,
      units: { sms: smsSegments(smsBody(env)), voice: voiceMinutes(renderText(env, 1500)) },
      tags: env.tags ?? [],
      destPrice: (t, country) => (t === "sms" || t === "voice" ? destUnitPrice(dest, t, country, tier) : null),
      mms: mmsMedia(env) !== null,
    });
    let publishPrice = actionPriceMicros(PRICES, "publish", tier);
    if (input.attachmentBytes) {
      const mbDays = (input.attachmentBytes / 1_048_576) * ((storeUntil - nowSec) / 86400);
      publishPrice += actionPriceMicros(PRICES, "attachment_upload", tier) + Math.ceil(rentNanos(PRICES, "attachment_mb_day", mbDays, tier) / 1000);
    }
    const liveAll = new Set(live.map((l) => l.id));
    const livePlanned = plan.deliveries.filter((d) => liveAll.has(d.subscriber));
    const liveAllowedIds = new Set(livePlanned.map((d) => d.subscriber));
    const liveCost = livePlanned.reduce((n, d) => n + d.cost_micros, 0);
    const queued = plan.deliveries.filter((d) => !liveAll.has(d.subscriber));
    const retentionNanos = rentNanos(PRICES, "retention_message_day", (storeUntil - nowSec) / 86400, tier);
    const retentionMicros = Math.ceil(retentionNanos / 1000);

    if (input.dryRun) {
      if (anonymous) throw rpcError("unauthorized", "dry runs need an account (they're charged as an API request)");
      await this.chargeCaller(caller, apiPrice, `dry:${idKey}`);
      const estimate = publishPrice + plan.costMicros + retentionMicros;
      return { message: env, created_topic: false, duplicate: false, cost_micros: estimate, plan: caller.accountId === meta.owner ? plan.deliveries : [], dry_run: true, store_until: storeUntil };
    }

    // Owner-side spend: live deliveries (+ the publish when anonymous), queued reservations,
    // and retention. Both daily counters are checked and incremented with no await in between,
    // so concurrent publishes can't all pass the same check; failures below roll them back.
    this.topicRateLimit(nowMs, meta);
    const queuedCost = queued.reduce((n, d) => n + d.cost_micros, 0);
    const ownerCost = liveCost + (anonymous ? publishPrice : 0);
    const ownerTotal = ownerCost + queuedCost;
    const ownerAll = ownerTotal + retentionMicros;
    const topicCapDelta = ownerAll + (!anonymous && caller.accountId === meta.owner ? publishPrice : 0);
    const anonKey = `anon_spend:${today()}`;
    if (anonymous) {
      this.anonRateLimit(nowMs, meta);
      const spent = this.kvGet<number>(anonKey) ?? 0;
      const cap = meta.policy.anon_daily_cap_micros ?? 1_000_000;
      if (spent + ownerAll > cap) throw rpcError("spend_cap_exceeded", "anonymous daily cap reached for this topic");
    }
    const topicKey = `topic_spend:${today()}`;
    const topicMonthKey = `topic_spend_month:${thisMonth()}`;
    const topicSpent = this.kvGet<number>(topicKey) ?? 0;
    const topicMonthSpent = this.kvGet<number>(topicMonthKey) ?? 0;
    if (meta.policy.daily_cap_micros != null && topicSpent + topicCapDelta > meta.policy.daily_cap_micros) {
      throw rpcError("spend_cap_exceeded", "topic daily cap reached", { cap: "topic_daily" });
    }
    if (meta.policy.monthly_cap_micros != null && topicMonthSpent + topicCapDelta > meta.policy.monthly_cap_micros) {
      throw rpcError("spend_cap_exceeded", "topic monthly cap reached", { cap: "topic_monthly" });
    }
    if (anonymous) this.bump(anonKey, ownerAll);
    this.kvPut(topicKey, topicSpent + topicCapDelta);
    this.kvPut(topicMonthKey, topicMonthSpent + topicCapDelta);
    let trackedTokenSpend = 0;
    const rollback = () => {
      if (anonymous) this.bump(anonKey, -ownerAll);
      this.bump(topicKey, -topicCapDelta);
      this.bump(topicMonthKey, -topicCapDelta);
    };
    try {

    // A token of the owner's own account is capped on everything it causes, not just the publish.
    if (caller.tokenId && caller.accountId === meta.owner) {
      const amt = ownerAll;
      const r = await accountStub(this.env, meta.owner).trackTokenSpend(caller.tokenId, amt, { tokenDaily: caller.caps.daily, tokenTotal: caller.caps.total });
      if (!r.ok && r.code === "spend_cap_exceeded") throw rpcError("spend_cap_exceeded", `spend cap reached: ${r.cap}`, { cap: r.cap, remaining_usd_micros: r.remaining });
      trackedTokenSpend = amt;
    }

    // Pay: owner first (lease), then the publisher (direct, with token caps).
    const paid = await this.spendOwner(ownerCost, retentionNanos, meta.owner);
    if (paid !== "ok") throw this.spendFailureError(paid, anonymous);
    if (!anonymous) {
      try {
        await this.chargeCaller(caller, publishPrice, `pub:${idKey}`);
      } catch (e) {
        this.refundOwner(ownerCost, retentionNanos);
        throw e;
      }
    }
    } catch (e) {
      rollback();
      if (trackedTokenSpend > 0 && caller.tokenId) {
        await accountStub(this.env, meta.owner).refundTokenSpend(caller.tokenId, trackedTokenSpend).catch(() => {});
      }
      throw e;
    }

    let created = false;
    if (!this.meta) {
      await this.configure(meta, input.autoCreateAccountTransports);
      created = true;
    }

    // Store and fan out (store canonical uppercase id for case-insensitive dedupe/traces/since while preserving env.id verbatim in json).
    const json = JSON.stringify(env);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO messages (id, time, expires, json) VALUES (?, ?, ?, ?)", idKey, time, storeUntil, json);
      if (signed) this.sql.exec("INSERT OR IGNORE INTO seen (id, until) VALUES (?, ?)", idKey, time + MAX_MESSAGE_AGE_S + MAX_CLOCK_SKEW_S);
      if (input.idempotencyKey) this.sql.exec("INSERT OR REPLACE INTO idem (key, body_hash, message_id, created) VALUES (?, ?, ?, ?)", input.idempotencyKey, input.bodyHash, idKey, nowMs);
    });
    this.broadcast(env, liveAllowedIds);

    // Queued (paid) transports: reserve per job; the delivery consumer settles.
    const jobs: { body: DeliveryJob; delaySeconds?: number }[] = [];
    const subs = new Map(this.queuedSubs().map((s) => [s.id, s]));
    const owner = accountStub(this.env, meta.owner);
    let sentCount = 0;
    try {
      for (const d of queued) {
        const sub = subs.get(d.subscriber);
        if (!sub || !this.env.DELIVERY) continue;
        const ref = `dlv:${idKey}:${sub.id}:${ulid()}`;
        const r = await accountStub(this.env, meta.owner).reserve(d.cost_micros, ref, null, {}, d.transport === "sms" || d.transport === "voice" || d.transport === "whatsapp" ? "telephony" : null, d.sku ? `sku=${d.sku}` : undefined);
        if (!r.ok) {
          this.trace(idKey, {}, storeUntil);
          await this.recordDelivery(idKey, { sub: sub.id, transport: d.transport, result: "not sent", error: r.code });
          continue;
        }
        const deadline_ms = input.route.deadlineS ? nowMs + input.route.deadlineS * 1000 : undefined;
        jobs.push({ body: { topic: meta.name, owner: meta.owner, message: env, sub: { ...sub, after_s: d.after_s }, reservation: { ref, micros: d.cost_micros }, attempt: 0, sku: d.sku, mode: input.route.mode, ...(deadline_ms ? { deadline_ms } : {}) }, delaySeconds: d.after_s || undefined });
      }
      if (jobs.length && this.env.DELIVERY) {
        // Cloudflare Queues sendBatch accepts at most 100 messages per call.
        for (let i = 0; i < jobs.length; i += 100) {
          await this.env.DELIVERY.sendBatch(jobs.slice(i, i + 100));
          sentCount = Math.min(jobs.length, i + 100);
        }
      }
    } catch (e) {
      // Give every unsent reservation back rather than leaving it stranded.
      for (const j of jobs.slice(sentCount)) await owner.release(j.body.reservation.ref).catch(() => {});
      await this.recordDelivery(idKey, { result: "queue failed", error: String((e as Error).message ?? e) });
    }

    const callerCost = (anonymous ? 0 : publishPrice) + (caller.accountId === meta.owner ? liveCost + queuedCost : 0);
    emitMetric(this.env, {
      accountId: meta.owner, event: "publish", transport: livePlanned.length ? livePlanned[0]!.transport : "", sku: "publish",
      detail: meta.name, revenueMicros: publishPrice + liveCost,
      providerCostMicros: estimatedCostMicros("publish") + estimatedCostMicros("deliver_live", livePlanned.length),
      units: 1 + livePlanned.length,
    });
    this.trace(idKey, { published: nowMs, plan: plan.deliveries, dropped: plan.dropped, cost_micros: { publish: publishPrice, live: liveCost, queued: queuedCost, retention_nanos: retentionNanos }, publisher: caller.tokenId ?? caller.deviceId ?? caller.accountId ?? "anonymous" }, storeUntil);
    await this.ensureAlarm();
    return { message: env, created_topic: created, duplicate: false, cost_micros: callerCost, plan: caller.accountId === meta.owner ? plan.deliveries : [], dry_run: false, store_until: storeUntil };
  }

  private topicRateLimit(nowMs: number, meta: TopicMeta | null = this.meta) {
    const rate = meta?.policy.rate_per_min;
    if (!rate) return;
    const burst = meta?.policy.burst ?? rate;
    if (!this.rateBucket) this.rateBucket = { tokens: burst, at: nowMs };
    const elapsed = Math.max(0, nowMs - this.rateBucket.at);
    const tokens = Math.min(burst, this.rateBucket.tokens + (elapsed / 60_000) * rate);
    if (tokens < 1) throw rpcError("rate_limited", "topic rate limit exceeded");
    this.rateBucket = { tokens: tokens - 1, at: nowMs };
  }

  private anonRateLimit(nowMs: number, meta: TopicMeta | null = this.meta) {
    const minute = Math.floor(nowMs / 60000);
    if (this.anonWindow.minute !== minute) this.anonWindow = { minute, count: 0 };
    if (this.anonWindow.count >= (meta?.policy.anon_rate_per_min ?? 60)) throw rpcError("rate_limited");
    this.anonWindow.count++;
  }

  private messageById(id: string): Envelope | null {
    const r = this.sql.exec<{ json: string }>("SELECT json FROM messages WHERE id = ?", id.toUpperCase()).toArray()[0];
    return r ? JSON.parse(r.json) : null;
  }

  // ---------- traces & acks ----------
  private trace(id: string, data: Record<string, unknown>, expires: number) {
    const key = id.toUpperCase();
    const prev = this.sql.exec<{ json: string }>("SELECT json FROM traces WHERE id = ?", key).toArray()[0];
    const merged = prev ? { ...JSON.parse(prev.json), ...data } : data;
    this.sql.exec("INSERT OR REPLACE INTO traces (id, json, expires) VALUES (?, ?, ?)", key, JSON.stringify(merged), expires);
  }

  async recordDelivery(id: string, event: Record<string, unknown>): Promise<void> {
    const key = id.toUpperCase();
    const prev = this.sql.exec<{ json: string; expires: number }>("SELECT json, expires FROM traces WHERE id = ?", key).toArray()[0];
    if (!prev) return;
    const t = JSON.parse(prev.json);
    (t.events ??= []).push({ at: Date.now(), ...event });
    this.sql.exec("UPDATE traces SET json = ? WHERE id = ?", JSON.stringify(t), key);
  }

  async getTrace(id: string, caller: Caller): Promise<RpcResult<Record<string, unknown> | null>> {
    return asResult(async () => this.getTraceInner(id, caller));
  }

  private getTraceInner(id: string, caller: Caller): Record<string, unknown> | null {
    if (!this.meta || caller.accountId !== this.meta.owner) throw rpcError("forbidden", "only the topic owner can see traces");
    const r = this.sql.exec<{ json: string }>("SELECT json FROM traces WHERE id = ?", id.toUpperCase()).toArray()[0];
    if (!r) return null;
    const acked = this.sql.exec<{ time: number; via: string }>("SELECT time, via FROM acks WHERE id = ?", id.toUpperCase()).toArray()[0];
    return { id, ...JSON.parse(r.json), ack: acked ?? null };
  }

  /** Ack from a subscriber: only callers who can read the topic may stop escalation. */
  async ackAs(id: string, via: string, caller: Caller): Promise<RpcResult<boolean>> {
    return asResult(async () => {
      this.checkRead(caller);
      await this.ack(id, via);
      return true;
    });
  }

  async ack(id: string, via: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO acks (id, time, via) VALUES (?, ?, ?)", id.toUpperCase(), Date.now(), via);
  }

  async markSent(ref: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO sent (ref, at) VALUES (?, ?)", ref, Date.now());
  }

  async wasSent(ref: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM sent WHERE ref = ?", ref).toArray().length > 0;
  }

  async isAcked(id: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM acks WHERE id = ?", id.toUpperCase()).toArray().length > 0;
  }

  // ---------- subscribe ----------
  private liveSubscribers(m: Envelope): { id: string; transport: "ws" | "sse" }[] {
    const out: { id: string; transport: "ws" | "sse" }[] = [];
    for (const s of this.streams.values()) if (matchesFilter(m, s.filter)) out.push({ id: s.id, transport: "sse" });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as WsAttachment | null;
      if (a && matchesFilter(m, a.filter)) out.push({ id: a.id, transport: "ws" });
    }
    return out;
  }

  private backlog(since: string | null, filter: SubscriptionFilter): Envelope[] {
    if (!since) return [];
    const now = Math.floor(Date.now() / 1000);
    let rows: { json: string }[];
    if (since === "all") {
      rows = this.sql.exec<{ json: string }>("SELECT json FROM messages WHERE expires >= ? ORDER BY seq LIMIT ?", now, MAX_BACKLOG).toArray();
    } else if (/^\d+$/.test(since)) {
      rows = this.sql.exec<{ json: string }>("SELECT json FROM messages WHERE time >= ? AND expires >= ? ORDER BY seq LIMIT ?", Number(since), now, MAX_BACKLOG).toArray();
    } else if (/^\d+[smhd]$/.test(since)) {
      const mult = { s: 1, m: 60, h: 3600, d: 86400 }[since.slice(-1) as "s" | "m" | "h" | "d"];
      const from = now - Number(since.slice(0, -1)) * mult;
      rows = this.sql.exec<{ json: string }>("SELECT json FROM messages WHERE time >= ? AND expires >= ? ORDER BY seq LIMIT ?", from, now, MAX_BACKLOG).toArray();
    } else {
      const seq = this.sql.exec<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", since.toUpperCase()).toArray()[0]?.seq;
      rows = seq === undefined
        ? this.sql.exec<{ json: string }>("SELECT json FROM messages WHERE expires >= ? ORDER BY seq LIMIT ?", now, MAX_BACKLOG).toArray()
        : this.sql.exec<{ json: string }>("SELECT json FROM messages WHERE seq > ? AND expires >= ? ORDER BY seq LIMIT ?", seq, now, MAX_BACKLOG).toArray();
    }
    return rows.map((r) => JSON.parse(r.json) as Envelope).filter((m) => matchesFilter(m, filter));
  }

  private checkRead(caller: Caller, transport?: "ws" | "sse" | "poll" | "mcp") {
    if (!this.meta) throw rpcError("not_found", "no such topic");
    if (this.accountPaused) throw rpcError("topic_paused", "account is paused");
    if (this.meta.policy.paused) throw rpcError("topic_paused");
    if (!this.canRead(caller)) throw rpcError("forbidden", "not allowed to read this topic");
    if (transport && !transportAllowed(
      transport,
      [caller.transports, this.accountTransports.allow, this.meta.policy.allow_transports],
      [caller.denyTransports, this.accountTransports.deny, this.meta.policy.deny_transports],
    )) {
      throw rpcError("transport_denied", `transport ${transport} denied by policy`);
    }
  }

  /** Verifies that `caller` is permitted to read this topic (for ntfy `GET /{topics}/auth`). */
  async checkAuth(caller: Caller): Promise<RpcResult<true>> {
    return asResult(async () => {
      this.checkRead(caller);
      return true as const;
    });
  }

  /** Poll: cached messages since `since`. Charged to the topic owner (D2). */
  async poll(params: SubscribeParams): Promise<RpcResult<Envelope[]>> {
    return asResult(() => this.pollInner(params));
  }

  private async pollInner(params: SubscribeParams): Promise<Envelope[]> {
    const transport = params.transport ?? "poll";
    this.checkRead(params.caller, transport);
    const msgs = this.backlog(params.since ?? "all", params.filter);
    const deliverySku = transport === "mcp" ? "deliver_mcp" : "deliver_live";
    const cost = actionPriceMicros(PRICES, "api_request", this.tier()) + msgs.length * actionPriceMicros(PRICES, deliverySku, this.tier());
    const tracked = await this.capTokenRead(params.caller, cost);
    const paid = await this.spendOwnerCapped(cost);
    if (paid !== "ok") {
      if (tracked) await this.refundTokenRead(params.caller, cost);
      throw this.spendFailureError(paid);
    }
    return msgs;
  }

  override async fetch(req: Request): Promise<Response> {
    const params = JSON.parse(req.headers.get("x-subetha-subscribe") ?? "null") as SubscribeParams | null;
    if (!params) return new Response("bad internal request", { status: 400 });
    const transport = params.transport ?? (params.format === "ws" ? "ws" : "sse");
    try {
      this.checkRead(params.caller, transport);
    } catch (e) {
      return new Response((e as Error).message, { status: 403 });
    }
    const backlog = this.backlog(params.since, params.filter);
    const deliverySku = transport === "mcp" ? "deliver_mcp" : "deliver_live";
    const cost = actionPriceMicros(PRICES, "api_request", this.tier()) + backlog.length * actionPriceMicros(PRICES, deliverySku, this.tier());
    let tracked = false;
    try {
      tracked = await this.capTokenRead(params.caller, cost);
    } catch (e) {
      return new Response((e as Error).message, { status: 403 });
    }
    const paid = await this.spendOwnerCapped(cost);
    if (paid !== "ok") {
      if (tracked) await this.refundTokenRead(params.caller, cost);
      const err = this.spendFailureError(paid);
      return new Response(err.message, { status: paid === "broke" ? 402 : 403 });
    }
    const id = `c_${ulid()}`;
    const openEvt = { id: ulid(), time: Math.floor(Date.now() / 1000), event: "open", topic: this.meta!.name };
    // Reset connection-rent clock when transitioning from 0 -> 1 live connections so idle periods aren't billed.
    if (this.streams.size + this.ctx.getWebSockets().length === 0) this.kvPut("rent_at", Date.now());
    await this.ensureAlarm();

    if (params.format === "ws") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id, filter: params.filter, deviceId: params.caller.deviceId } satisfies WsAttachment);
      server.send(JSON.stringify(openEvt));
      for (const m of backlog) server.send(JSON.stringify(m));
      return new Response(null, { status: 101, webSocket: client });
    }

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start: (c) => { controller = c; },
      cancel: () => { this.streams.delete(id); },
    });
    const stream: Stream = {
      id, format: params.format, filter: params.filter, deviceId: params.caller.deviceId,
      send: (b) => { try { controller.enqueue(b); } catch { this.streams.delete(id); } },
      close: () => { try { controller.close(); } catch { /* already closed */ } },
    };
    if (params.format !== "raw") stream.send(this.frame(params.format, openEvt as Envelope));
    for (const m of backlog) stream.send(this.frame(params.format, m));
    this.streams.set(id, stream);
    this.startKeepalive();
    const ct = params.format === "sse" ? "text/event-stream" : params.format === "json" ? "application/x-ndjson" : "text/plain";
    return new Response(readable, { headers: { "content-type": `${ct}; charset=utf-8`, "cache-control": "no-cache", "x-accel-buffering": "no" } });
  }

  private frame(format: StreamFormat, m: Envelope): Uint8Array {
    if (format === "sse") return enc.encode(`${m.event && m.event !== "message" ? `event: ${m.event}\n` : ""}${m.id ? `id: ${m.id}\n` : ""}data: ${JSON.stringify(m)}\n\n`);
    if (format === "raw") return enc.encode((m.event === "keepalive" ? "" : (m.message ?? "").replace(/\n/g, " ")) + "\n");
    return enc.encode(JSON.stringify(m) + "\n");
  }

  private broadcast(m: Envelope, allowedIds: Set<string>) {
    for (const s of this.streams.values()) {
      if (!allowedIds.has(s.id) || !matchesFilter(m, s.filter)) continue;
      s.send(this.frame(s.format, m));
    }
    const data = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as WsAttachment | null;
      if (a && allowedIds.has(a.id) && matchesFilter(m, a.filter)) {
        try { ws.send(data); } catch { /* closed */ }
      }
    }
  }

  private startKeepalive() {
    if (this.keepalive) return;
    this.keepalive = setInterval(() => {
      if (this.streams.size === 0) {
        clearInterval(this.keepalive!);
        this.keepalive = null;
        return;
      }
      const k = { id: ulid(), time: Math.floor(Date.now() / 1000), event: "keepalive", topic: this.meta?.name } as Envelope;
      for (const s of this.streams.values()) s.send(this.frame(s.format, k));
    }, KEEPALIVE_MS);
  }

  private closeAll(code: number, reason: string) {
    for (const s of this.streams.values()) s.close();
    this.streams.clear();
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(code, reason); } catch { /* already closed */ }
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    try {
      const m = JSON.parse(message) as { event?: string; id?: string };
      if (m.event === "ack" && typeof m.id === "string") await this.ack(m.id, "ws");
      else if (m.event === "ping") ws.send(JSON.stringify({ event: "pong", time: Math.floor(Date.now() / 1000) }));
    } catch {
      /* ignore malformed frames */
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, "closing"); } catch { /* ignore */ }
  }

  // ---------- housekeeping ----------
  override async alarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM messages WHERE expires < ?", Math.floor(now / 1000));
    this.sql.exec("DELETE FROM traces WHERE expires < ?", Math.floor(now / 1000));
    this.sql.exec("DELETE FROM idem WHERE created < ?", now - 86_400_000);
    this.sql.exec("DELETE FROM sent WHERE at < ?", now - 7 * 86_400_000);
    // Connection rent since the last alarm.
    const conns = this.streams.size + this.ctx.getWebSockets().length;
    const last = this.kvGet<number>("rent_at") ?? now;
    if (conns > 0) {
      const nanos = rentNanos(PRICES, "connection_hour", (conns * Math.max(0, now - last)) / 3_600_000, this.tier());
      const paid = await this.spendOwner(0, nanos);
      if (paid !== "ok") this.closeAll(paid === "paused" ? 4403 : 4402, paid === "paused" ? "account paused" : "topic owner's balance is empty");
    }
    this.kvPut("rent_at", now);
    await this.returnLeases(conns === 0);
    const remaining = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n;
    if (conns > 0 || this.leases.length > 0 || remaining > 0) await this.ctx.storage.setAlarm(now + ALARM_MS);
  }

  /** Test/ops hook: return all leases now. */
  async flushLeases(): Promise<void> {
    await this.returnLeases(true);
  }

  /** Close live connections matching a specific device (e.g. on device pause/revocation). */
  async closeDevice(deviceId: string, code = 4403, reason = "device revoked"): Promise<void> {
    for (const [id, s] of this.streams) {
      if (s.deviceId === deviceId) {
        s.close();
        this.streams.delete(id);
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as WsAttachment | null;
      if (a?.deviceId === deviceId) {
        try { ws.close(code, reason); } catch { /* already closed */ }
      }
    }
  }
}

/** Typed RPC surface (Envelope's index signature defeats the generated Rpc types). */
export type TopicRpc = Pick<TopicDO, "configure" | "destroy" | "setAccountTransports" | "setAccountPaused" | "setTier" | "getMeta" | "subscriberCounts" | "setSubscriptions" | "publish" | "checkAuth" | "poll" | "fetch" | "recordDelivery" | "getTrace" | "ack" | "ackAs" | "isAcked" | "markSent" | "wasSent" | "flushLeases" | "closeDevice">;

export function topicStub(env: Env, topic: string): TopicRpc {
  return env.TOPIC.get(env.TOPIC.idFromName(topic)) as unknown as TopicRpc;
}
