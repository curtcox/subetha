import { describe, expect, it } from "vitest";
import { Ledger, MemoryLedgerStore } from "../src/ledger.ts";

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe("Ledger", () => {
  it("tops up idempotently", () => {
    const l = new Ledger(new MemoryLedgerStore());
    expect(l.topup(1000, "cs_1").applied).toBe(true);
    expect(l.topup(1000, "cs_1").applied).toBe(false);
    expect(l.available).toBe(1000);
  });

  it("reserves, settles, releases", () => {
    const l = new Ledger(new MemoryLedgerStore());
    l.topup(100, "t");
    expect(l.reserve(60, "a").ok).toBe(true);
    expect(l.reserve(50, "b")).toMatchObject({ ok: false, code: "insufficient_balance", shortfall: 10 });
    expect(l.settle("a", 20)).toEqual({ charged: 20, released: 40 });
    expect(l.available).toBe(80);
    expect(l.reserved).toBe(0);
    l.reserve(10, "c");
    expect(l.release("c")).toBe(10);
    expect(l.available).toBe(80);
  });

  it("enforces token caps and account caps", () => {
    const l = new Ledger(new MemoryLedgerStore(), () => Date.UTC(2026, 0, 1));
    l.topup(1_000_000, "t");
    const caps = { tokenDaily: 100, tokenTotal: 150 };
    expect(l.charge(80, "1", { tokenId: "tk", caps }).ok).toBe(true);
    expect(l.charge(30, "2", { tokenId: "tk", caps })).toMatchObject({ ok: false, cap: "token_daily", remaining: 20 });
    expect(l.charge(20, "3", { tokenId: "tk", caps }).ok).toBe(true);
    const later = new Ledger((l as unknown as { s: MemoryLedgerStore }).s, () => Date.UTC(2026, 0, 2));
    expect(later.charge(60, "4", { tokenId: "tk", caps })).toMatchObject({ ok: false, cap: "token_total", remaining: 50 });
    expect(later.charge(500, "5", { caps: { accountDaily: 400 } })).toMatchObject({ ok: false, cap: "account_daily" });
    // Monthly cap spans multiple days in the same UTC calendar month and resets next month.
    expect(later.charge(100, "m1", { caps: { accountMonthly: 180 } })).toMatchObject({ ok: false, cap: "account_monthly", remaining: 80 });
    expect(later.charge(80, "m2", { caps: { accountMonthly: 180 } }).ok).toBe(true);
    const nextMonth = new Ledger((l as unknown as { s: MemoryLedgerStore }).s, () => Date.UTC(2026, 1, 1));
    expect(nextMonth.charge(180, "m3", { caps: { accountMonthly: 180 } }).ok).toBe(true);
  });

  it("released reservations don't count against caps", () => {
    const l = new Ledger(new MemoryLedgerStore());
    l.topup(1000, "t");
    l.reserve(100, "r", { tokenId: "tk", caps: { tokenDaily: 100 } });
    l.release("r");
    expect(l.charge(100, "c", { tokenId: "tk", caps: { tokenDaily: 100 } }).ok).toBe(true);
  });

  it("leases grant at most the balance and return the unused part", () => {
    const l = new Ledger(new MemoryLedgerStore());
    l.topup(50, "t");
    expect(l.lease(100, 1000, "x")).toEqual({ granted: 0, shortfall: 50 });
    expect(l.lease(10, 1000, "y")).toEqual({ granted: 50 });
    expect(l.available).toBe(0);
    expect(l.returnLease("y", 30)).toEqual({ spent: 20 });
    expect(l.available).toBe(30);
  });

  it("chargebacks clamp at zero and report the unrecovered amount", () => {
    const l = new Ledger(new MemoryLedgerStore());
    l.topup(100, "t");
    expect(l.adjust(-150, "dp_1", "chargeback")).toEqual({ applied: -100, unrecovered: 50 });
    expect(l.available).toBe(0);
    expect(l.adjust(-150, "dp_1", "chargeback")).toEqual({ applied: 0, unrecovered: 0 });
  });

  it("property: random operation sequences never drive balances negative and conserve money", () => {
    for (let run = 0; run < 300; run++) {
      const r = rng(run + 1);
      const store = new MemoryLedgerStore();
      const l = new Ledger(store);
      let toppedUp = 0;
      let spent = 0;
      let adjusted = 0;
      const open: string[] = [];
      const leases: string[] = [];
      for (let i = 0; i < 200; i++) {
        const op = Math.floor(r() * 8);
        const amt = Math.floor(r() * 500);
        try {
          if (op === 0) { if (l.topup(amt, `t${i}`).applied) toppedUp += amt; }
          else if (op === 1) { if (l.reserve(amt, `r${i}`, { tokenId: r() < 0.5 ? "tk" : null, caps: { tokenDaily: r() < 0.3 ? 1000 : null } }).ok) open.push(`r${i}`); }
          else if (op === 2 && open.length) { const ref = open.splice(Math.floor(r() * open.length), 1)[0]!; spent += l.settle(ref, Math.floor(r() * 600)).charged; }
          else if (op === 3 && open.length) { l.release(open.splice(Math.floor(r() * open.length), 1)[0]!); }
          else if (op === 4) { const g = l.lease(Math.floor(amt / 4), amt, `l${i}`); if (g.granted) leases.push(`l${i}:${g.granted}`); }
          else if (op === 5 && leases.length) { const [ref, g] = leases.splice(0, 1)[0]!.split(":"); spent += l.returnLease(ref!, Math.floor(r() * Number(g) * 1.5), "").spent; }
          else if (op === 6) { const res = l.charge(amt, `c${i}`); if (res.ok) spent += amt; }
          else if (op === 7) { adjusted += l.adjust(r() < 0.5 ? -amt : amt, `a${i}`, "adjust").applied; }
        } catch (e) {
          throw new Error(`run ${run} op ${i}: ${(e as Error).message}`);
        }
        expect(l.available).toBeGreaterThanOrEqual(0);
        expect(l.reserved).toBeGreaterThanOrEqual(0);
        expect(l.available + l.reserved + spent).toBe(toppedUp + adjusted);
      }
    }
  });
});
