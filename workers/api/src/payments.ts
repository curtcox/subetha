// Payment history and receipts (PLAN §11: billing shows "invoices/receipts"). Every Stripe
// payment credited to an account is in stripe_payments; a receipt is rendered from that row, so
// it shows what was paid, the top-up fee, the credit added, and any later refund or dispute.
import type { Context, Hono } from "hono";
import { topupSplit, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { getAccount } from "./accounts.ts";
import { requireAdmin } from "./auth.ts";
import { ApiError } from "./errors.ts";
import type { Env, Principal } from "./types.ts";

const PRICES = prices as unknown as PriceTable;
type Vars = { Bindings: Env; Variables: { principal: Principal } };
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

interface PaymentRow {
  payment_intent: string;
  account_id: string;
  amount_micros: number;
  fee_micros: number | null;
  kind: string | null;
  refunded_micros: number;
  disputed: number;
  created_at: number;
}

export interface Payment {
  id: string;
  kind: "checkout" | "auto_recharge";
  amount_micros: number;
  fee_micros: number;
  credit_micros: number;
  refunded_micros: number;
  disputed: boolean;
  created_at: number;
}

/** The fee recorded when the payment was credited; rows from before fees were recorded are recomputed. */
function feeOf(r: PaymentRow): number {
  if (r.fee_micros !== null) return r.fee_micros;
  try {
    return topupSplit(PRICES, r.amount_micros).feeMicros;
  } catch {
    return 0;
  }
}

export function toPayment(r: PaymentRow): Payment {
  const fee = feeOf(r);
  return {
    id: r.payment_intent,
    kind: r.kind === "auto_recharge" ? "auto_recharge" : "checkout",
    amount_micros: r.amount_micros,
    fee_micros: fee,
    credit_micros: r.amount_micros - fee,
    refunded_micros: r.refunded_micros,
    disputed: !!r.disputed,
    created_at: r.created_at,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const money = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

export function receiptHtml(p: Payment, acct: { id: string; handle: string | null; email: string | null }): string {
  const date = new Date(p.created_at).toISOString().slice(0, 10);
  const rows: [string, string][] = [
    ["Receipt", p.id],
    ["Date", date],
    ["Account", acct.handle ? `@${acct.handle} (${acct.id})` : acct.id],
    ...(acct.email ? ([["Billed to", acct.email]] as [string, string][]) : []),
    ["Description", p.kind === "auto_recharge" ? "SubEtha balance top-up (auto-recharge)" : "SubEtha balance top-up"],
    ["Amount paid", money(p.amount_micros)],
    ["Top-up fee", money(p.fee_micros)],
    ["Credit added to balance", money(p.credit_micros)],
    ...(p.refunded_micros ? ([["Refunded", `−${money(p.refunded_micros)}`]] as [string, string][]) : []),
    ...(p.disputed ? ([["Status", "Disputed (chargeback)"]] as [string, string][]) : []),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SubEtha receipt ${esc(p.id)}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.4rem;margin:0 0 .25rem}table{width:100%;border-collapse:collapse;margin:1.5rem 0}
td{padding:.4rem 0;border-bottom:1px solid #ddd;vertical-align:top}td:last-child{text-align:right;font-variant-numeric:tabular-nums;word-break:break-all}
small{color:#555}@media print{button{display:none}}
</style></head><body>
<h1>SubEtha receipt</h1><small>subetha.org · prepaid balance, no subscription</small>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
<small>Paid by card through Stripe. Balance credit is used for metered relay usage at the prices on subetha.org/docs/pricing.</small>
<p><button onclick="print()">Print</button></p>
</body></html>`;
}

export function registerPaymentRoutes(app: Hono<Vars>, principal: PrincipalFn) {
  app.get("/v1/payments", async (c) => {
    const id = requireAdmin(await principal(c));
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const { results } = await c.env.DB.prepare("SELECT * FROM stripe_payments WHERE account_id = ? ORDER BY created_at DESC LIMIT ?").bind(id, limit).all<PaymentRow>();
    return c.json({ payments: results.map(toPayment) });
  });

  app.get("/v1/payments/:id/receipt", async (c) => {
    const id = requireAdmin(await principal(c));
    const row = await c.env.DB.prepare("SELECT * FROM stripe_payments WHERE payment_intent = ? AND account_id = ?").bind(c.req.param("id"), id).first<PaymentRow>();
    if (!row) throw new ApiError("not_found");
    const acct = await getAccount(c.env, id);
    const html = receiptHtml(toPayment(row), { id, handle: acct?.handle ?? null, email: acct?.email ?? null });
    return c.html(html, 200, { "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  });
}
