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
