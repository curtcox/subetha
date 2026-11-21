// AccountDO: one per account. Single-threaded, so double-spends are impossible (PLAN §7).
import { DurableObject } from "cloudflare:workers";
import { Ledger, type Caps, type Entry, type LedgerStore, type Reservation, type ReserveResult } from "../ledger.ts";
import type { Env } from "../types.ts";

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

  private async scheduleJournal() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }

  async balance(): Promise<Balance> {
    return { available: this.ledger.available, reserved: this.ledger.reserved };
  }

  async topup(amount: number, ref: string, meta?: string) {
    return this.tx(() => this.ledger.topup(amount, ref, meta));
  }

  async charge(amount: number, ref: string, tokenId: string | null, caps: Caps): Promise<ReserveResult> {
    return this.tx(() => this.ledger.charge(amount, ref, { tokenId, caps }));
  }

  async reserve(amount: number, ref: string, tokenId: string | null, caps: Caps): Promise<ReserveResult> {
    return this.tx(() => this.ledger.reserve(amount, ref, { tokenId, caps }));
  }

  async settle(ref: string, actual: number) {
    return this.tx(() => this.ledger.settle(ref, actual));
  }

  async release(ref: string) {
    return this.tx(() => this.ledger.release(ref));
  }

  async lease(min: number, max: number, ref: string) {
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

  async setAccountId(id: string) {
    await this.ctx.storage.put("account_id", id);
  }
}

export type AccountRpc = Pick<AccountDO, "balance" | "topup" | "charge" | "reserve" | "settle" | "release" | "lease" | "returnLease" | "adjust" | "entries" | "setAccountId">;

export function accountStub(env: Env, accountId: string): AccountRpc {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId)) as unknown as AccountRpc;
}
