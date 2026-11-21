// Device enrollment and device-signed requests (PLAN §9). Until the devicebasedauth.org flow is
// settled (open question 1), devices enroll with a device-code flow (RFC 8628-style) approved
// from the console, or are registered directly by an admin token.
//
// Signed requests carry:
//   X-Device-Id: dev_…            (Ed25519 public key, spec §1.3)
//   X-Device-Time: <unix seconds> (±300 s)
//   X-Device-Nonce: 16–64 random base64url chars (single use)
//   X-Device-Signature: base64url(Ed25519("subetha-req-v1\n" + METHOD + "\n" + host + "\n" + path?query + "\n" + time + "\n" + nonce + "\n" + hex(sha256(body))))
// The host binds a signature to one deployment (a staging signature isn't valid in production).
import type { Context, Hono } from "hono";
import { base64urlDecode, DEVICE_ID_RE, publicKeyFromDeviceId, utf8 } from "@subetha/sdk/protocol";
import { audit } from "./accounts.ts";
import { requireAdmin } from "./auth.ts";
import { randomBase32, sha256Hex } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import { accountStub } from "./durable/account.ts";
import type { Env, Principal } from "./types.ts";

type Vars = { Bindings: Env; Variables: { principal: Principal } };
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

export const REQ_DOMAIN = "subetha-req-v1\n";
export const ENROLL_DOMAIN = "subetha-enroll-v1\n";
const SKEW_S = 300;
const CODE_TTL_MS = 10 * 60_000;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no accidental words

async function ed25519Verify(deviceId: string, sigB64: string, data: string): Promise<boolean> {
  try {
    const pk = publicKeyFromDeviceId(deviceId);
    const sig = base64urlDecode(sigB64);
    if (sig.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", pk as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig as BufferSource, utf8.encode(data) as BufferSource);
  } catch {
    return false;
  }
}

export async function requestSigningInput(method: string, url: string, time: string, nonce: string, body: Uint8Array): Promise<string> {
  const u = new URL(url);
  return `${REQ_DOMAIN}${method.toUpperCase()}\n${u.host}\n${u.pathname}${u.search}\n${time}\n${nonce}\n${await sha256Hex(body)}`;
}

/** Returns a device principal for a correctly signed request from an enrolled device, null if unsigned. */
export async function authenticateDevice(req: Request, env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<Principal | null> {
  const id = req.headers.get("x-device-id");
  if (!id) return null;
  const time = req.headers.get("x-device-time") ?? "";
  const sig = req.headers.get("x-device-signature") ?? "";
  const nonce = req.headers.get("x-device-nonce") ?? "";
  if (!DEVICE_ID_RE.test(id) || !/^\d+$/.test(time) || Math.abs(nowSec - Number(time)) > SKEW_S || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new ApiError("unauthorized", "bad device signature headers");
  const body = new Uint8Array(await req.clone().arrayBuffer());
  if (!(await ed25519Verify(id, sig, await requestSigningInput(req.method, req.url, time, nonce, body)))) throw new ApiError("unauthorized", "bad device signature");
  const row = await env.DB.prepare("SELECT account_id FROM devices WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ account_id: string }>();
  if (!row) throw new ApiError("unauthorized", "device not enrolled");
  if (!(await accountStub(env, row.account_id).claimNonce(`sig:${await sha256Hex(sig)}`, 2 * SKEW_S * 1000))) throw new ApiError("unauthorized", "replayed device signature");
  env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), id).run().catch(() => {});
  return { kind: "device", accountId: row.account_id, deviceId: id };
}

function userCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(b, (x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function registerDeviceRoutes(app: Hono<Vars>, principal: PrincipalFn) {
  app.get("/v1/devices", async (c) => {
    const id = requireAdmin(await principal(c));
    const { results } = await c.env.DB.prepare("SELECT id, name, capabilities, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? ORDER BY created_at DESC").bind(id).all();
    return c.json({ devices: results.map((d) => ({ ...d, capabilities: JSON.parse(d.capabilities as string) })) });
  });

  app.post("/v1/devices", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const body = (await c.req.json()) as { device_id?: string; name?: string; capabilities?: string[] };
    if (!body.device_id || !DEVICE_ID_RE.test(body.device_id)) throw new ApiError("bad_request", "device_id must be dev_<base32 ed25519 public key>");
    try { publicKeyFromDeviceId(body.device_id); } catch { throw new ApiError("bad_request", "non-canonical device id"); }
    await c.env.DB.prepare("INSERT INTO devices (id, account_id, name, capabilities, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(body.device_id, accountId, body.name ?? "", JSON.stringify(body.capabilities ?? []), Date.now()).run()
      .catch((e) => { throw String(e).includes("UNIQUE") ? new ApiError("conflict", "device already enrolled") : e; });
    await audit(c.env, accountId, p.kind, "device.enroll", { id: body.device_id });
    return c.json({ id: body.device_id, enrolled: true }, 201);
  });

  app.delete("/v1/devices/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const r = await c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(Date.now(), c.req.param("id"), accountId).run();
    if (!r.meta.changes) throw new ApiError("not_found");
    await audit(c.env, accountId, p.kind, "device.revoke", { id: c.req.param("id") });
    return c.json({ revoked: true });
  });

  // Device-code flow, step 1: the device asks for a code, proving it holds its key.
  app.post("/v1/device/code", async (c) => {
    const body = (await c.req.json()) as { device_id?: string; name?: string; capabilities?: string[]; time?: number; proof?: string };
    const id = body.device_id ?? "";
    const now = Math.floor(Date.now() / 1000);
    if (!DEVICE_ID_RE.test(id) || typeof body.time !== "number" || Math.abs(now - body.time) > SKEW_S || !body.proof) throw new ApiError("bad_request", "device_id, time, and proof are required");
    if (!(await ed25519Verify(id, body.proof, `${ENROLL_DOMAIN}${id}\n${body.time}`))) throw new ApiError("unauthorized", "bad proof");
    const deviceCode = randomBase32(20);
    const code = userCode();
    await c.env.DB.prepare("INSERT INTO device_codes (device_code_hash, user_code, device_id, name, capabilities, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(deviceCode), code, id, (body.name ?? "").slice(0, 64), JSON.stringify(body.capabilities ?? []), Date.now(), Date.now() + CODE_TTL_MS).run();
    return c.json({ device_code: deviceCode, user_code: code, verification_uri: `${c.env.BASE_URL}/console/#device`, verification_uri_complete: `${c.env.BASE_URL}/console/#device=${code}`, expires_in: CODE_TTL_MS / 1000, interval: 5 });
  });

  // Step 2: a signed-in user approves the code in the console.
  app.post("/v1/device/approve", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const { user_code } = (await c.req.json()) as { user_code?: string };
    const row = await c.env.DB.prepare("SELECT * FROM device_codes WHERE user_code = ?").bind((user_code ?? "").toUpperCase()).first<{ device_code_hash: string; device_id: string; name: string; capabilities: string; account_id: string | null; expires_at: number }>();
    if (!row || row.expires_at < Date.now() || row.account_id) throw new ApiError("not_found", "unknown or expired code");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE device_codes SET account_id = ? WHERE device_code_hash = ?").bind(accountId, row.device_code_hash),
      // Re-enrolling a revoked device (or one already ours) is fine; taking over another account's active device is not.
      c.env.DB.prepare("INSERT INTO devices (id, account_id, name, capabilities, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, revoked_at = NULL WHERE devices.revoked_at IS NOT NULL OR devices.account_id = excluded.account_id").bind(row.device_id, accountId, row.name, row.capabilities, Date.now()),
    ]);
    await audit(c.env, accountId, p.kind, "device.enroll", { id: row.device_id, via: "code" });
    return c.json({ device_id: row.device_id, name: row.name, enrolled: true });
  });

  // Step 3: the device polls until approved.
  app.post("/v1/device/token", async (c) => {
    const { device_code } = (await c.req.json()) as { device_code?: string };
    const row = await c.env.DB.prepare("SELECT device_id, account_id, expires_at FROM device_codes WHERE device_code_hash = ?").bind(await sha256Hex(device_code ?? "")).first<{ device_id: string; account_id: string | null; expires_at: number }>();
    if (!row || (row.expires_at < Date.now() && !row.account_id)) return c.json({ error: "expired_token" }, 400);
    if (!row.account_id) return c.json({ error: "authorization_pending" }, 400);
    return c.json({ device_id: row.device_id, account_id: row.account_id, auth: "Sign requests with X-Device-Id / X-Device-Time / X-Device-Signature" });
  });
}
