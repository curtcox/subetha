// Stripe Checkout top-ups (prepaid balance, no subscription) and webhook verification.
import { hmacSha256Hex, timingSafeEqual } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import type { Env } from "./types.ts";

function form(obj: Record<string, string | number | undefined>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export async function createCheckoutSession(env: Env, opts: { accountId: string; amountMicros: number; successUrl: string; cancelUrl: string; email?: string | null; saveCard?: boolean; customer?: string | null }): Promise<{ id: string; url: string }> {
  if (!env.STRIPE_SECRET_KEY) throw new ApiError("provider_unavailable", "Stripe is not configured");
  const cents = Math.round(opts.amountMicros / 10_000);
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: form({
      mode: "payment",
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": cents,
      "line_items[0][price_data][product_data][name]": "SubEtha balance top-up",
      "payment_intent_data[metadata][account_id]": opts.accountId,
      "metadata[account_id]": opts.accountId,
      "metadata[amount_micros]": opts.amountMicros,
      client_reference_id: opts.accountId,
      customer: opts.customer ?? undefined,
      customer_email: opts.customer ? undefined : opts.email ?? undefined,
      customer_creation: opts.saveCard && !opts.customer ? "always" : undefined,
      "payment_intent_data[setup_future_usage]": opts.saveCard ? "off_session" : undefined,
      "payment_method_options[card][request_three_d_secure]": "automatic",
    }),
  });
  const body = (await r.json()) as { id?: string; url?: string; error?: { message: string } };
  if (!r.ok || !body.id || !body.url) throw new ApiError("provider_unavailable", `Stripe error: ${body.error?.message ?? r.status}`);
  return { id: body.id, url: body.url };
}

/** Verifies a Stripe-Signature header (v1 scheme) with a 5-minute tolerance. */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(nowSec - t) > 300 || sigs.length === 0) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

export async function signStripePayload(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${payload}`)}`;
}

/**
 * Off-session top-up with the customer's saved card (auto-recharge). The balance is credited
 * by the payment_intent.succeeded webhook, never here, so a charge is never credited twice.
 */
export async function chargeSavedCard(env: Env, opts: { customer: string; amountMicros: number; accountId: string; idempotencyKey: string }): Promise<{ id: string; status: string }> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured");
  const auth = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  const pm = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${encodeURIComponent(opts.customer)}&type=card&limit=1`, { headers: auth });
  const pms = (await pm.json()) as { data?: { id: string }[]; error?: { message: string } };
  const method = pms.data?.[0]?.id;
  if (!pm.ok || !method) throw new Error(`no saved card: ${pms.error?.message ?? "none on file"}`);
  const r = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded", "idempotency-key": opts.idempotencyKey },
    body: form({
      amount: Math.round(opts.amountMicros / 10_000),
      currency: "usd",
      customer: opts.customer,
      payment_method: method,
      off_session: "true",
      confirm: "true",
      "metadata[account_id]": opts.accountId,
      "metadata[auto_recharge]": "1",
    }),
  });
  const body = (await r.json()) as { id?: string; status?: string; error?: { message: string } };
  if (!r.ok || !body.id) throw new Error(`Stripe error: ${body.error?.message ?? r.status}`);
  return { id: body.id, status: body.status ?? "unknown" };
}
