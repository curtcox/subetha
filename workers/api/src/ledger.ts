// Prepaid balance ledger (PLAN §7 "Balance safety", §8 rule 3). Pure logic over a synchronous
// store so it can run inside a Durable Object (SQLite) and in property tests (memory).
//
// Invariants:
//   - available ≥ 0 and reserved ≥ 0 at all times; nothing is ever billed after the fact.
//   - every money movement is an append-only entry; topups/adjusts are idempotent by ref.

export type EntryKind = "topup" | "reserve" | "settle" | "release" | "refund" | "adjust" | "lease" | "lease_return";

export interface Entry {
  seq: number;
  kind: EntryKind;
  amount: number; // µ$, signed effect on `available` (reserve/lease negative, release positive)
  ref: string;
  available_after: number;
  reserved_after: number;
  time: number;
  meta?: string;
}

export interface Reservation { ref: string; amount: number; tokenId: string | null; time: number }

export interface Caps {
  /** Per-token daily cap (µ$). */
  tokenDaily?: number | null;
  /** Per-token lifetime cap (µ$). */
  tokenTotal?: number | null;
  /** Account daily cap (µ$). */
  accountDaily?: number | null;
  /** Account monthly cap (µ$, UTC calendar month). */
  accountMonthly?: number | null;
}

export interface LedgerStore {
  getAvailable(): number;
  setAvailable(v: number): void;
  getReserved(): number;
  setReserved(v: number): void;
  getReservation(ref: string): Reservation | null;
  putReservation(r: Reservation): void;
  deleteReservation(ref: string): void;
  hasRef(ref: string): boolean;
  addRef(ref: string): void;
  appendEntry(e: Omit<Entry, "seq">): Entry;
  /** Spend already committed or reserved for a token/account key on a day ("YYYY-MM-DD") or "total". */
  getSpend(key: string, period: string): number;
  addSpend(key: string, period: string, delta: number): void;
}

export type ReserveResult =
  | { ok: true; available: number }
  | { ok: false; code: "insufficient_balance"; shortfall: number; available: number }
  | { ok: false; code: "spend_cap_exceeded"; cap: "token_daily" | "token_total" | "account_daily" | "account_monthly" | "account_paused"; remaining: number };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const month = (t: number) => new Date(t).toISOString().slice(0, 7);
const assertAmount = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`amount must be a non-negative integer µ$, got ${n}`);
};

export class Ledger {
  private readonly s: LedgerStore;
  private readonly now: () => number;
  constructor(store: LedgerStore, now: () => number = Date.now) {
    this.s = store;
    this.now = now;
  }

  get available() { return this.s.getAvailable(); }
  get reserved() { return this.s.getReserved(); }

  private entry(kind: EntryKind, amount: number, ref: string, meta?: string) {
    return this.s.appendEntry({ kind, amount, ref, available_after: this.s.getAvailable(), reserved_after: this.s.getReserved(), time: this.now(), meta });
  }

  /** Credit a top-up. Idempotent by ref (e.g. the Stripe checkout session id). */
  topup(amount: number, ref: string, meta?: string): { applied: boolean; available: number } {
    assertAmount(amount);
    const key = `topup:${ref}`;
    if (this.s.hasRef(key)) return { applied: false, available: this.available };
    this.s.addRef(key);
    this.s.setAvailable(this.available + amount);
    this.entry("topup", amount, ref, meta);
    return { applied: true, available: this.available };
  }

  /** Reserve worst-case cost before acting. */
  reserve(amount: number, ref: string, opts: { tokenId?: string | null; caps?: Caps } = {}): ReserveResult {
    assertAmount(amount);
    if (this.s.getReservation(ref)) throw new Error(`duplicate reservation ref ${ref}`);
    const { tokenId = null, caps = {} } = opts;
    const today = day(this.now());
    if (tokenId) {
      if (caps.tokenDaily != null) {
        const spent = this.s.getSpend(`t:${tokenId}`, today);
        if (spent + amount > caps.tokenDaily) return { ok: false, code: "spend_cap_exceeded", cap: "token_daily", remaining: Math.max(0, caps.tokenDaily - spent) };
      }
      if (caps.tokenTotal != null) {
        const spent = this.s.getSpend(`t:${tokenId}`, "total");
        if (spent + amount > caps.tokenTotal) return { ok: false, code: "spend_cap_exceeded", cap: "token_total", remaining: Math.max(0, caps.tokenTotal - spent) };
      }
    }
    if (caps.accountDaily != null) {
      const spent = this.s.getSpend("a", today);
      if (spent + amount > caps.accountDaily) return { ok: false, code: "spend_cap_exceeded", cap: "account_daily", remaining: Math.max(0, caps.accountDaily - spent) };
    }
    if (caps.accountMonthly != null) {
      const spent = this.s.getSpend("a", month(this.now()));
      if (spent + amount > caps.accountMonthly) return { ok: false, code: "spend_cap_exceeded", cap: "account_monthly", remaining: Math.max(0, caps.accountMonthly - spent) };
    }
    const avail = this.available;
    if (amount > avail) return { ok: false, code: "insufficient_balance", shortfall: amount - avail, available: avail };
    this.s.setAvailable(avail - amount);
    this.s.setReserved(this.reserved + amount);
    this.s.putReservation({ ref, amount, tokenId, time: this.now() });
    this.addSpend(tokenId, amount);
    this.entry("reserve", -amount, ref);
    return { ok: true, available: this.available };
  }

  private addSpend(tokenId: string | null, delta: number) {
    const now = this.now();
    const today = day(now);
    this.s.addSpend("a", today, delta);
    this.s.addSpend("a", month(now), delta);
    if (tokenId) {
      this.s.addSpend(`t:${tokenId}`, today, delta);
      this.s.addSpend(`t:${tokenId}`, "total", delta);
    }
  }

  /** Settle a reservation to its actual cost (≤ reserved); the rest is released. */
  settle(ref: string, actual: number): { charged: number; released: number } {
    assertAmount(actual);
    const r = this.s.getReservation(ref);
    // Already settled (e.g. a retried delivery job): settling twice is a no-op, never a charge.
    if (!r) return { charged: 0, released: 0 };
    const charged = Math.min(actual, r.amount);
    const released = r.amount - charged;
    this.s.deleteReservation(ref);
    this.s.setReserved(this.reserved - r.amount);
    this.s.setAvailable(this.available + released);
    if (released) this.addSpend(r.tokenId, -released);
    this.entry("settle", released, ref, `charged=${charged}`);
    return { charged, released };
  }

  release(ref: string): number {
    return this.settle(ref, 0).released;
  }

  /**
   * Reserve and settle in one step (for fixed-price actions). With `once`, a second charge with
   * the same ref is a no-op (used by metering jobs that may re-run).
   */
  charge(amount: number, ref: string, opts: { tokenId?: string | null; caps?: Caps; once?: boolean } = {}): ReserveResult {
    if (opts.once) {
      if (this.s.hasRef(`charge:${ref}`)) return { ok: true, available: this.available };
    }
    const r = this.reserve(amount, ref, opts);
    if (r.ok) {
      this.settle(ref, amount);
      if (opts.once) this.s.addRef(`charge:${ref}`);
    }
    return r.ok ? { ok: true, available: this.available } : r;
  }

  /**
   * Count spend that moves through leases or owner reservations against a token's caps,
   * without moving money (money moves when the lease/reservation is taken).
   */
  trackTokenSpend(tokenId: string, amount: number, caps: Caps): ReserveResult {
    assertAmount(amount);
    const today = day(this.now());
    if (caps.tokenDaily != null) {
      const spent = this.s.getSpend(`t:${tokenId}`, today);
      if (spent + amount > caps.tokenDaily) return { ok: false, code: "spend_cap_exceeded", cap: "token_daily", remaining: Math.max(0, caps.tokenDaily - spent) };
    }
    if (caps.tokenTotal != null) {
      const spent = this.s.getSpend(`t:${tokenId}`, "total");
      if (spent + amount > caps.tokenTotal) return { ok: false, code: "spend_cap_exceeded", cap: "token_total", remaining: Math.max(0, caps.tokenTotal - spent) };
    }
    this.s.addSpend(`t:${tokenId}`, today, amount);
    this.s.addSpend(`t:${tokenId}`, "total", amount);
    return { ok: true, available: this.available };
  }

  /**
   * Grant a credit lease to a hot path (TopicDO). Like a reservation, but settled by the
   * holder returning what it didn't spend. Grants at most `max` and at least `min`.
   */
  lease(min: number, max: number, ref: string): { granted: number } | { granted: 0; shortfall: number } {
    assertAmount(min);
    assertAmount(max);
    const avail = this.available;
    if (avail < min) return { granted: 0, shortfall: min - avail };
    const granted = Math.min(max, avail);
    this.s.setAvailable(avail - granted);
    this.s.setReserved(this.reserved + granted);
    this.s.putReservation({ ref, amount: granted, tokenId: null, time: this.now() });
    this.addSpend(null, granted);
    this.entry("lease", -granted, ref);
    return { granted };
  }

  /** Return a lease: `unused` goes back to available, the rest is recorded as spent. */
  returnLease(ref: string, unused: number, meta?: string): { spent: number } {
    const r = this.s.getReservation(ref);
    if (!r) throw new Error(`unknown lease ${ref}`);
    const back = Math.min(Math.max(0, unused), r.amount);
    this.s.deleteReservation(ref);
    this.s.setReserved(this.reserved - r.amount);
    this.s.setAvailable(this.available + back);
    if (back) this.addSpend(null, -back);
    this.entry("lease_return", back, ref, meta);
    return { spent: r.amount - back };
  }

  /**
   * Admin/automatic adjustment (refund, chargeback recovery). Negative adjustments are clamped
   * so available never drops below zero; the unrecovered remainder is reported.
   */
  adjust(amount: number, ref: string, reason: string): { applied: number; unrecovered: number } {
    if (!Number.isSafeInteger(amount)) throw new Error("amount must be an integer");
    const key = `adjust:${ref}`;
    if (this.s.hasRef(key)) return { applied: 0, unrecovered: 0 };
    this.s.addRef(key);
    const applied = amount >= 0 ? amount : -Math.min(-amount, this.available);
    this.s.setAvailable(this.available + applied);
    this.entry(amount < 0 && reason.startsWith("refund") ? "refund" : "adjust", applied, ref, reason);
    return { applied, unrecovered: applied - amount };
  }
}

/** In-memory store for tests and simulations. */
export class MemoryLedgerStore implements LedgerStore {
  available = 0;
  reserved = 0;
  reservations = new Map<string, Reservation>();
  refs = new Set<string>();
  entries: Entry[] = [];
  spend = new Map<string, number>();
  getAvailable() { return this.available; }
  setAvailable(v: number) { this.available = v; }
  getReserved() { return this.reserved; }
  setReserved(v: number) { this.reserved = v; }
  getReservation(ref: string) { return this.reservations.get(ref) ?? null; }
  putReservation(r: Reservation) { this.reservations.set(r.ref, r); }
  deleteReservation(ref: string) { this.reservations.delete(ref); }
  hasRef(ref: string) { return this.refs.has(ref); }
  addRef(ref: string) { this.refs.add(ref); }
  appendEntry(e: Omit<Entry, "seq">) { const full = { ...e, seq: this.entries.length + 1 }; this.entries.push(full); return full; }
  getSpend(key: string, period: string) { return this.spend.get(`${key}|${period}`) ?? 0; }
  addSpend(key: string, period: string, delta: number) { this.spend.set(`${key}|${period}`, this.getSpend(key, period) + delta); }
}
