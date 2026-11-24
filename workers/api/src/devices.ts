// Device enrollment and device-signed requests (PLAN §9). Until the devicebasedauth.org flow is
// settled (open question 1), devices enroll with a device-code flow (RFC 8628-style) approved
// from the console, or are registered directly by an admin token.
//
// Signed requests (spec §8.1) carry:
//   X-Device-Id: dev_…            (Ed25519 public key, spec §1.3)
//   X-Device-Time: <unix seconds> (±300 s)
//   X-Device-Nonce: 16–64 random base64url chars (single use)
//   X-Device-Signed-Headers: x-device-id,x-device-time,x-device-nonce,content-type,x-title,…
//   X-Device-Signature: base64url(Ed25519("subetha-req-v2\n" + METHOD + "\n" + host + "\n" +
//     path?query + "\n" + hex(sha256(body)) + ("\n" + name + ":" + value for each signed header)))
// Every content or routing header present (COVERED_REQUEST_HEADERS) must be signed. The host
// binds a signature to one deployment (a staging signature isn't valid in production).
//
// The older subetha-req-v1 form (no X-Device-Signed-Headers; time and nonce in fixed positions)
// is still accepted for requests that carry no covered header, so it can't be used to alter a
// request's content or routing.
import type { Context, Hono } from "hono";
import { base64urlDecode, COVERED_REQUEST_HEADERS, DEVICE_ID_RE, parseSignedHeaders, publicKeyFromDeviceId, requestSigningInputV2, utf8, type Transport } from "@subetha/sdk/protocol";
import { audit } from "./accounts.ts";
import { actorOf, requireAdmin, validateTransports } from "./auth.ts";
import { randomBase32, sha256Hex } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import { accountStub } from "./durable/account.ts";
import { topicStub } from "./durable/topic.ts";
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

/** The signing input for a v2 request, or for a v1 request with no covered headers. Throws if neither. */
async function signingInput(req: Request, time: string, nonce: string, body: Uint8Array): Promise<string> {
  const list = req.headers.get("x-device-signed-headers");
  if (list === null) {
    for (const [n] of req.headers) {
      if (COVERED_REQUEST_HEADERS.has(n)) throw new ApiError("unauthorized", `${n} isn't covered by a subetha-req-v1 signature; sign with subetha-req-v2`);
    }
    return requestSigningInput(req.method, req.url, time, nonce, body);
  }
  const names = parseSignedHeaders(list);
  if (typeof names === "string") throw new ApiError("unauthorized", `bad X-Device-Signed-Headers: ${names}`);
  const signed = new Set(names);
  for (const [n] of req.headers) {
    if (COVERED_REQUEST_HEADERS.has(n) && !signed.has(n)) throw new ApiError("unauthorized", `${n} must be signed (X-Device-Signed-Headers)`);
  }
  const pairs: [string, string][] = [];
  for (const n of names) {
    const v = req.headers.get(n);
    if (v === null) throw new ApiError("unauthorized", `signed header ${n} is missing`);
    pairs.push([n, v]);
  }
  return requestSigningInputV2(req.method, req.url, body, pairs);
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
  if (!(await ed25519Verify(id, sig, await signingInput(req, time, nonce, body)))) throw new ApiError("unauthorized", "bad device signature");
  const row = await env.DB.prepare("SELECT account_id, paused, allow_transports, deny_transports FROM devices WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ account_id: string; paused: number; allow_transports: string | null; deny_transports: string | null }>();
  if (!row) throw new ApiError("unauthorized", "device not enrolled");
  if (row.paused) throw new ApiError("topic_paused", "device is paused");
  if (!(await accountStub(env, row.account_id).claimNonce(`sig:${await sha256Hex(sig)}`, 2 * SKEW_S * 1000))) throw new ApiError("unauthorized", "replayed device signature");
  env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), id).run().catch(() => {});
  return {
    kind: "device",
    accountId: row.account_id,
    deviceId: id,
    transports: row.allow_transports ? (JSON.parse(row.allow_transports) as Transport[]) : null,
    denyTransports: row.deny_transports ? (JSON.parse(row.deny_transports) as Transport[]) : null,
  };
}

/** Name and capabilities are stored per device; keep them small (they're user-supplied). */
function deviceFields(body: { name?: unknown; capabilities?: unknown }): { name: string; capabilities: string } {
  const name = typeof body.name === "string" ? body.name.slice(0, 64) : "";
  const caps = body.capabilities ?? [];
  if (!Array.isArray(caps) || caps.length > 32 || !caps.every((x) => typeof x === "string" && x.length <= 32)) {
    throw new ApiError("bad_request", "capabilities must be at most 32 strings of up to 32 characters");
  }
  return { name, capabilities: JSON.stringify(caps) };
}

/** Checks an enrollment proof (the device signs "subetha-enroll-v1\n<id>\n<time>" with its key). */
async function checkProof(body: { device_id?: string; time?: number; proof?: string }): Promise<string> {
  const id = body.device_id ?? "";
  const now = Math.floor(Date.now() / 1000);
  if (!DEVICE_ID_RE.test(id) || typeof body.time !== "number" || Math.abs(now - body.time) > SKEW_S || !body.proof) {
    throw new ApiError("bad_request", "device_id, time, and proof are required (see enrollmentProof in the SDKs)");
  }
  try { publicKeyFromDeviceId(id); } catch { throw new ApiError("bad_request", "non-canonical device id"); }
  if (!(await ed25519Verify(id, body.proof, `${ENROLL_DOMAIN}${id}\n${body.time}`))) throw new ApiError("unauthorized", "bad proof");
  return id;
}

function userCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(b, (x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function publicDevice(d: Record<string, unknown>) {
  return {
    id: d.id,
    name: d.name,
    capabilities: JSON.parse((d.capabilities as string) || "[]"),
    paused: !!d.paused,
    allow_transports: d.allow_transports ? JSON.parse(d.allow_transports as string) : null,
    deny_transports: d.deny_transports ? JSON.parse(d.deny_transports as string) : null,
    created_at: d.created_at,
    last_seen_at: d.last_seen_at ?? null,
    revoked_at: d.revoked_at ?? null,
  };
}

async function closeDeviceStreams(env: Env, accountId: string, deviceId: string, reason: string) {
  const { results } = await env.DB.prepare("SELECT name FROM topics WHERE owner_account_id = ?").bind(accountId).all<{ name: string }>();
  for (const r of results) await topicStub(env, r.name).closeDevice(deviceId, 4403, reason);
}

export function registerDeviceRoutes(app: Hono<Vars>, principal: PrincipalFn) {
  app.get("/v1/devices", async (c) => {
    const id = requireAdmin(await principal(c));
    const { results } = await c.env.DB.prepare("SELECT id, name, capabilities, paused, allow_transports, deny_transports, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? ORDER BY created_at DESC").bind(id).all();
    return c.json({ devices: results.map(publicDevice) });
  });

  app.patch("/v1/devices/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const id = c.req.param("id");
    const existing = await c.env.DB.prepare("SELECT id FROM devices WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(id, accountId).first();
    if (!existing) throw new ApiError("not_found");
    const body = (await c.req.json()) as { name?: unknown; capabilities?: unknown; paused?: unknown; allow_transports?: unknown; deny_transports?: unknown };
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.length > 64) throw new ApiError("bad_request", "name must be a string of up to 64 characters");
      await c.env.DB.prepare("UPDATE devices SET name = ? WHERE id = ?").bind(body.name, id).run();
    }
    if (body.capabilities !== undefined) {
      if (!Array.isArray(body.capabilities) || !body.capabilities.every((x) => typeof x === "string" && x.length <= 32)) {
        throw new ApiError("bad_request", "capabilities must be an array of strings");
      }
      await c.env.DB.prepare("UPDATE devices SET capabilities = ? WHERE id = ?").bind(JSON.stringify(body.capabilities.slice(0, 16)), id).run();
    }
    if (body.paused !== undefined) {
      if (typeof body.paused !== "boolean") throw new ApiError("bad_request", "paused must be a boolean");
      await c.env.DB.prepare("UPDATE devices SET paused = ? WHERE id = ?").bind(body.paused ? 1 : 0, id).run();
      if (body.paused) await closeDeviceStreams(c.env, accountId, id, "device paused");
    }
    if (body.allow_transports !== undefined) {
      const list = validateTransports(body.allow_transports);
      await c.env.DB.prepare("UPDATE devices SET allow_transports = ? WHERE id = ?").bind(list?.length ? JSON.stringify(list) : null, id).run();
    }
    if (body.deny_transports !== undefined) {
      const list = validateTransports(body.deny_transports);
      await c.env.DB.prepare("UPDATE devices SET deny_transports = ? WHERE id = ?").bind(list?.length ? JSON.stringify(list) : null, id).run();
    }
    await audit(c.env, accountId, actorOf(p), "device.update", { id, ...body });
    const updated = await c.env.DB.prepare("SELECT id, name, capabilities, paused, allow_transports, deny_transports, created_at, last_seen_at, revoked_at FROM devices WHERE id = ?").bind(id).first();
    return c.json(publicDevice(updated!));
  });

  app.post("/v1/devices", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    // Device ids are public (every signed message carries one), so registering one directly
    // needs the same proof of key possession as the code flow.
    const body = (await c.req.json()) as { device_id?: string; name?: string; capabilities?: string[]; time?: number; proof?: string };
    const id = await checkProof(body);
    const f = deviceFields(body);
    await c.env.DB.prepare("INSERT INTO devices (id, account_id, name, capabilities, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, accountId, f.name, f.capabilities, Date.now()).run()
      .catch((e) => { throw String(e).includes("UNIQUE") ? new ApiError("conflict", "device already enrolled") : e; });
    await audit(c.env, accountId, actorOf(p), "device.enroll", { id });
    return c.json({ id, enrolled: true }, 201);
  });

  app.delete("/v1/devices/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const id = c.req.param("id");
    const r = await c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(Date.now(), id, accountId).run();
    if (!r.meta.changes) throw new ApiError("not_found");
    await closeDeviceStreams(c.env, accountId, id, "device revoked");
    await audit(c.env, accountId, actorOf(p), "device.revoke", { id });
    return c.json({ revoked: true });
  });

  // Device-code flow, step 1: the device asks for a code, proving it holds its key.
  app.post("/v1/device/code", async (c) => {
    const body = (await c.req.json()) as { device_id?: string; name?: string; capabilities?: string[]; time?: number; proof?: string };
    const id = await checkProof(body);
    const f = deviceFields(body);
    const deviceCode = randomBase32(20);
    const code = userCode();
    await c.env.DB.batch([
      // One pending code per device: a new request replaces the old one.
      c.env.DB.prepare("DELETE FROM device_codes WHERE device_id = ? AND account_id IS NULL").bind(id),
      c.env.DB.prepare("INSERT INTO device_codes (device_code_hash, user_code, device_id, name, capabilities, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(await sha256Hex(deviceCode), code, id, f.name, f.capabilities, Date.now(), Date.now() + CODE_TTL_MS),
    ]);
    return c.json({ device_code: deviceCode, user_code: code, verification_uri: `${c.env.BASE_URL}/console/#device`, verification_uri_complete: `${c.env.BASE_URL}/console/#device=${code}`, expires_in: CODE_TTL_MS / 1000, interval: 5 });
  });

  // Step 2: a signed-in user approves the code in the console.
  app.post("/v1/device/approve", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const { user_code } = (await c.req.json()) as { user_code?: string };
    const row = await c.env.DB.prepare("SELECT * FROM device_codes WHERE user_code = ?").bind((user_code ?? "").toUpperCase()).first<{ device_code_hash: string; device_id: string; name: string; capabilities: string; account_id: string | null; expires_at: number }>();
    if (!row || row.expires_at < Date.now() || row.account_id) throw new ApiError("not_found", "unknown or expired code");
    // Re-enrolling a revoked device (or one already ours) is fine; taking over another account's
    // active device is not, and then the approval must fail rather than report success.
    const r = await c.env.DB.prepare("INSERT INTO devices (id, account_id, name, capabilities, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, revoked_at = NULL WHERE devices.revoked_at IS NOT NULL OR devices.account_id = excluded.account_id")
      .bind(row.device_id, accountId, row.name, row.capabilities, Date.now()).run();
    if (!r.meta.changes) throw new ApiError("conflict", "this device is enrolled in another account; revoke it there first");
    await c.env.DB.prepare("UPDATE device_codes SET account_id = ? WHERE device_code_hash = ?").bind(accountId, row.device_code_hash).run();
    await audit(c.env, accountId, actorOf(p), "device.enroll", { id: row.device_id, via: "code" });
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
