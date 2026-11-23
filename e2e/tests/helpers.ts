import { createHmac } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export interface DevAccount { account_id: string; handle: string; token: string }

/** A fresh account through the local-only bootstrap endpoint, with a unique handle. */
export async function bootstrap(request: APIRequestContext, creditUsd = 0): Promise<DevAccount> {
  const handle = `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const r = await request.post("/v1/dev/bootstrap", { data: { secret: "local-dev-only", handle, credit_usd: creditUsd } });
  expect(r.status()).toBe(201);
  return (await r.json()) as DevAccount;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Available balance in µ$ from the API. */
export async function balance(request: APIRequestContext, token: string): Promise<number> {
  return (await funds(request, token)).available;
}

/**
 * Available and held µ$. Held covers open reservations and the credit leases a topic takes from its
 * owner for fan-out (up to 1¢ each), so available + held is what the account still owns.
 */
export async function funds(request: APIRequestContext, token: string): Promise<{ available: number; held: number; total: number }> {
  const r = await request.get("/v1/account", { headers: auth(token) });
  expect(r.ok()).toBe(true);
  const a = (await r.json()) as { balance_usd_micros: number; reserved_usd_micros: number };
  return { available: a.balance_usd_micros, held: a.reserved_usd_micros, total: a.balance_usd_micros + a.reserved_usd_micros };
}

/** The price of one unit of a SKU at the standard tier, in µ$. */
export async function price(request: APIRequestContext, sku: string): Promise<number> {
  const prices = (await (await request.get("/v1/prices")).json()) as { skus: Record<string, { price_nanos: { standard: number } }> };
  return Math.ceil(prices.skus[sku]!.price_nanos.standard / 1000);
}

/** The balance the console header shows (available + held), in µ$. */
export async function headerFunds(page: Page): Promise<number> {
  const micros = (t: string | null) => Math.round(Number((t ?? "").match(/\$([0-9.]+)/)?.[1] ?? 0) * 1e6);
  return micros(await page.locator("#bal").textContent()) + micros(await page.locator("#held").textContent());
}

/** Signs into the console with an API token (the non-Clerk path) and waits for the app to show. */
export async function signIn(page: Page, token: string, hash = ""): Promise<void> {
  await page.goto(`/console/${hash}`);
  await page.locator("#tokenInput").fill(token);
  await page.locator("#tokenBtn").click();
  await expect(page.locator("#app")).toBeVisible();
}

/** The console formats balances under one cent with six decimals (console.js `usd`). */
export const usd = (micros: number) => `$${(micros / 1e6).toFixed(micros < 10000 ? 6 : 2)}`;

// ---------- the mock Twilio (mock-twilio.mjs) ----------
export const TWILIO = `http://localhost:${Number(process.env.E2E_PORT ?? 8788) + 2}`;
const TWILIO_TOKEN = "e2e-twilio-token"; // serve.mjs
export const BASE = `http://localhost:${process.env.E2E_PORT ?? 8788}`;

export interface MockCall { kind: "sms" | "voice"; to: string; body?: string; twiml?: string; status_callback?: string; auth?: string }

/** A US number no other test uses, so the shared mock's records stay apart. */
export const uniqueNumber = () => `+1415${String(2 + Math.floor(Math.random() * 8))}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

export async function callsTo(request: APIRequestContext, to: string): Promise<MockCall[]> {
  return (await (await request.get(`${TWILIO}/__calls?to=${encodeURIComponent(to)}`)).json()) as MockCall[];
}

export function twilioSignature(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", TWILIO_TOKEN).update(data).digest("base64");
}

/** POSTs a form to the relay as Twilio would, with X-Twilio-Signature. */
export async function asTwilio(request: APIRequestContext, url: string, params: Record<string, string>) {
  return request.post(url, { form: params, headers: { "X-Twilio-Signature": twilioSignature(url, params) } });
}

/** Adds an SMS or voice endpoint and verifies it with the code the relay sent through the mock. */
export async function verifiedPhone(request: APIRequestContext, token: string, kind: "sms" | "voice"): Promise<{ id: string; number: string }> {
  const number = uniqueNumber();
  const r = await request.post("/v1/endpoints", { headers: auth(token), data: { kind, address: number } });
  expect(r.status()).toBe(201);
  const ep = (await r.json()) as { id: string };
  const [sent] = await callsTo(request, number);
  expect(sent?.kind).toBe(kind);
  const text = kind === "sms" ? sent!.body! : /code is ([^.]*)\./.exec(sent!.twiml!)![1]!;
  const code = text.replace(/\D/g, "").slice(0, 6);
  expect(code).toMatch(/^\d{6}$/);
  const v = await request.post(`/v1/endpoints/${ep.id}/verify`, { headers: auth(token), data: { code } });
  expect(v.ok()).toBe(true);
  return { id: ep.id, number };
}
