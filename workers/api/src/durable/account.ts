// AccountDO: one per account. Single-threaded, so double-spends are impossible (PLAN §7).
import { DurableObject } from "cloudflare:workers";
import { Ledger, type Caps, type Entry, type LedgerStore, type Reservation, type ReserveResult } from "../ledger.ts";
import type { Env } from "../types.ts";
import { chargeSavedCard } from "../stripe.ts";

class SqlLedgerStore implements LedgerStore {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (ref TEXT PRIMARY KEY, amount INTEGER NOT NULL, token_id TEXT, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refs (ref TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, amount INTEGER, ref TEXT, available_after INTEGER, reserved_after INTEGER, time INTEGER, meta TEXT);
      CREATE TABLE IF NOT EXISTS spend (key TEXT, period TEXT, amount INTEGER NOT NULL, PRIMARY KEY (key, period));`);
  }
  private get(k: string): number {
    const r = this.sql.exec<{ v: number }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return r?.v ?? 0;
  }
  private set(k: string, v: number) {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
  getAvailable() { return this.get("available"); }
  setAvailable(v: number) { this.set("available", v); }
  getReserved() { return this.get("reserved"); }
  setReserved(v: number) { this.set("reserved", v); }
  getReservation(ref: string): Reservation | null {
    const r = this.sql.exec<{ ref: string; amount: number; token_id: string | null; time: number }>("SELECT * FROM reservations WHERE ref = ?", ref).toArray()[0];
    return r ? { ref: r.ref, amount: r.amount, tokenId: r.token_id, time: r.time } : null;
  }
  putReservation(r: Reservation) {
    this.sql.exec("INSERT INTO reservations (ref, amount, token_id, time) VALUES (?, ?, ?, ?)", r.ref, r.amount, r.tokenId, r.time);
  }
  deleteReservation(ref: string) { this.sql.exec("DELETE FROM reservations WHERE ref = ?", ref); }
  hasRef(ref: string) { return this.sql.exec("SELECT 1 FROM refs WHERE ref = ?", ref).toArray().length > 0; }
  addRef(ref: string) { this.sql.exec("INSERT INTO refs (ref) VALUES (?)", ref); }
  appendEntry(e: Omit<Entry, "seq">): Entry {
    const r = this.sql.exec<{ seq: number }>(
      "INSERT INTO entries (kind, amount, ref, available_after, reserved_after, time, meta) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
      e.kind, e.amount, e.ref, e.available_after, e.reserved_after, e.time, e.meta ?? null,
    ).one();
    return { ...e, seq: r.seq };
  }
  getSpend(key: string, period: string) {
    const r = this.sql.exec<{ amount: number }>("SELECT amount FROM spend WHERE key = ? AND period = ?", key, period).toArray()[0];
    return r?.amount ?? 0;
  }
  addSpend(key: string, period: string, delta: number) {
    this.sql.exec("INSERT INTO spend (key, period, amount) VALUES (?, ?, ?) ON CONFLICT(key, period) DO UPDATE SET amount = amount + excluded.amount", key, period, delta);
  }
}

const HOLD_DAYS = 7;
const MAX_RECHARGES_PER_DAY = 3;
const RECHARGE_COOLDOWN_MS = 10 * 60_000;

export interface AutoRecharge { threshold_micros: number; amount_micros: number; customer: string }
const TELEPHONY_HOLD_CAP_MICROS = 5_000_000;

export interface Balance { available: number; reserved: number }

export class AccountDO extends DurableObject<Env> {
  private readonly ledger: Ledger;
  private readonly store: SqlLedgerStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlLedgerStore(ctx.storage.sql);
    this.ledger = new Ledger(this.store);
  }

  private tx<T>(fn: () => T): T {
    const out = this.ctx.storage.transactionSync(fn);
    void this.scheduleJournal();
    return out;
  }

  // ---------- auto-recharge ----------
  /** Enable (or disable with null) auto-recharge. The alarm tops up when available < threshold. */
  async setAutoRecharge(cfg: AutoRecharge | null): Promise<void> {
    if (cfg) await this.ctx.storage.put("auto_recharge", cfg);
    else await this.ctx.storage.delete("auto_recharge");
    await this.scheduleJournal();
  }

  async autoRechargeFailed(reason: string): Promise<void> {
    await this.ctx.storage.delete("auto_recharge");
    await this.ctx.storage.put("auto_recharge_last_error", reason);
  }

  private async maybeRecharge(now: number) {
    const cfg = await this.ctx.storage.get<AutoRecharge>("auto_recharge");
    if (!cfg || this.ledger.available >= cfg.threshold_micros) return;
    if (((await this.ctx.storage.get<number>("recharge_pending_until")) ?? 0) > now) return;
    const day = new Date(now).toISOString().slice(0, 10);
    const count = (await this.ctx.storage.get<number>(`recharges:${day}`)) ?? 0;
    if (count >= MAX_RECHARGES_PER_DAY) return;
    const accountId = (await this.ctx.storage.get<string>("account_id")) ?? this.ctx.id.toString();
    await this.ctx.storage.put({ recharge_pending_until: now + RECHARGE_COOLDOWN_MS, [`recharges:${day}`]: count + 1 });
    try {
      await chargeSavedCard(this.env, { customer: cfg.customer, amountMicros: cfg.amount_micros, accountId, idempotencyKey: `recharge:${accountId}:${day}:${count}` });
    } catch (e) {
      await this.autoRechargeFailed(String((e as Error).message ?? e));
    }
  }

  private async scheduleJournal() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }

  async balance(): Promise<Balance> {
    return { available: this.ledger.available, reserved: this.ledger.reserved };
  }

  async topup(amount: number, ref: string, meta?: string) {
    return this.tx(() => {
      const r = this.ledger.topup(amount, ref, meta);
      if (r.applied && this.store.getSpend("first_topup_at", "ms") === 0) this.store.addSpend("first_topup_at", "ms", Date.now());
      return r;
    });
  }

  // ---------- account controls (kill switch, daily cap) ----------
  async setControls(c: { paused: boolean; dailyCapMicros: number | null }): Promise<void> {
    await this.ctx.storage.put("controls", c);
    this.controls = c;
  }

  private controls: { paused: boolean; dailyCapMicros: number | null } | null = null;
  private async getControls() {
    this.controls ??= (await this.ctx.storage.get<{ paused: boolean; dailyCapMicros: number | null }>("controls")) ?? { paused: false, dailyCapMicros: null };
    return this.controls;
  }
  private async withControls(caps: Caps): Promise<Caps | null> {
    const c = await this.getControls();
    if (c.paused) return null;
    return { ...caps, accountDaily: c.dailyCapMicros ?? caps.accountDaily };
  }
  private static PAUSED: ReserveResult = { ok: false, code: "spend_cap_exceeded", cap: "account_paused", remaining: 0 };

  async charge(amount: number, ref: string, tokenId: string | null, caps: Caps, once = false): Promise<ReserveResult> {
    const c = await this.withControls(caps);
    if (!c) return AccountDO.PAUSED;
    return this.tx(() => this.ledger.charge(amount, ref, { tokenId, caps: c, once }));
  }

  /**
   * Reserve before acting. Category "telephony" (SMS/voice) is subject to the new-funds hold:
   * until the first top-up is HOLD_DAYS old, total telephony spend is capped (PLAN §8).
   */
  async reserve(amount: number, ref: string, tokenId: string | null, caps: Caps, category: "telephony" | null = null): Promise<ReserveResult> {
    const withCtl = await this.withControls(caps);
    if (!withCtl) return AccountDO.PAUSED;
    caps = withCtl;
    return this.tx(() => {
      if (category === "telephony") {
        const first = this.store.getSpend("first_topup_at", "ms");
        const young = first === 0 || Date.now() - first < HOLD_DAYS * 86_400_000;
        const spent = this.store.getSpend("telephony", "total");
        if (young && spent + amount > TELEPHONY_HOLD_CAP_MICROS) {
          return { ok: false, code: "spend_cap_exceeded", cap: "account_daily", remaining: Math.max(0, TELEPHONY_HOLD_CAP_MICROS - spent) } as ReserveResult;
        }
      }
      const r = this.ledger.reserve(amount, ref, { tokenId, caps });
      if (r.ok && category === "telephony") this.store.addSpend("telephony", "total", amount);
      return r;
    });
  }

  async trackTokenSpend(tokenId: string, amount: number, caps: Caps): Promise<ReserveResult> {
    return this.tx(() => this.ledger.trackTokenSpend(tokenId, amount, caps));
  }

  async settle(ref: string, actual: number) {
    return this.tx(() => this.ledger.settle(ref, actual));
  }

  async release(ref: string) {
    return this.tx(() => this.ledger.release(ref));
  }

  async lease(min: number, max: number, ref: string) {
    const c = await this.getControls();
    if (c.paused) return { granted: 0 as const, shortfall: min };
    if (c.dailyCapMicros != null) {
      const left = c.dailyCapMicros - this.store.getSpend("a", new Date().toISOString().slice(0, 10));
      if (left < min) return { granted: 0 as const, shortfall: min - Math.max(0, left) };
      max = Math.min(max, left);
    }
    return this.tx(() => this.ledger.lease(min, max, ref));
  }

  async returnLease(ref: string, unused: number, meta?: string) {
    return this.tx(() => this.ledger.returnLease(ref, unused, meta));
  }

  async adjust(amount: number, ref: string, reason: string) {
    return this.tx(() => this.ledger.adjust(amount, ref, reason));
  }

  async entries(afterSeq = 0, limit = 100): Promise<Entry[]> {
    return this.ctx.storage.sql
      .exec("SELECT * FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", afterSeq, Math.min(limit, 1000))
      .toArray()
      .map((e) => ({ ...(e as unknown as Entry), meta: (e.meta as string | null) ?? undefined }));
  }

  /** Journals new ledger entries to D1 (nightly reconciliation compares this to Stripe). */
  override async alarm() {
    await this.maybeRecharge(Date.now());
    this.sweepStaleReservations(Date.now());
    const accountId = (await this.ctx.storage.get<string>("account_id")) ?? this.ctx.id.toString();
    const journaled = (await this.ctx.storage.get<number>("journaled_seq")) ?? 0;
    const batch = await this.entries(journaled, 500);
    if (batch.length === 0) return;
    try {
      await this.env.DB.batch(batch.map((e) =>
        this.env.DB.prepare("INSERT OR IGNORE INTO ledger_journal (account_id, seq, kind, amount, ref, available_after, reserved_after, time, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(accountId, e.seq, e.kind, e.amount, e.ref, e.available_after, e.reserved_after, e.time, e.meta ?? null)));
      await this.ctx.storage.put("journaled_seq", batch[batch.length - 1]!.seq);
    } catch (err) {
      console.error("journal failed", err);
    }
    if (batch.length === 500) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  /** Delivery reservations older than a day are settled in full (the action may have happened). */
  private sweepStaleReservations(now: number) {
    const stale = this.ctx.storage.sql.exec<{ ref: string; amount: number }>("SELECT ref, amount FROM reservations WHERE time < ? AND ref LIKE 'dlv:%'", now - 86_400_000).toArray();
    for (const r of stale) this.tx(() => this.ledger.settle(r.ref, r.amount));
    if (this.ctx.storage.sql.exec("SELECT 1 FROM reservations LIMIT 1").toArray().length) void this.ctx.storage.setAlarm(now + 3_600_000);
  }

  async setAccountId(id: string) {
    await this.ctx.storage.put("account_id", id);
  }
}

export type AccountRpc = Pick<AccountDO, "balance" | "topup" | "charge" | "reserve" | "settle" | "release" | "lease" | "returnLease" | "adjust" | "entries" | "setAccountId" | "setAutoRecharge" | "autoRechargeFailed" | "trackTokenSpend" | "setControls">;

export function accountStub(env: Env, accountId: string): AccountRpc {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId)) as unknown as AccountRpc;
}
