// Apple Push Notification service with provider-token (JWT) auth. The endpoint address is the
// hex device token.
//
// HTTP/2 caveat: APNs only speaks HTTP/2, and a Worker's outbound fetch() is not guaranteed to
// negotiate HTTP/2 with api.push.apple.com. Operators can set APNS_ENDPOINT to an HTTP/1.1 →
// HTTP/2 relay that forwards /3/device/{token} verbatim (headers included), or deliver to iOS
// through FCM instead (fcm.ts), which talks to APNs on our behalf.
import type { Env } from "../types.ts";
import { alertText, pemToDer, signJwt, trimEnvelope, unverifyEndpoint } from "./push.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender } from "./senders.ts";

export const APNS_DEFAULT_ENDPOINT = "https://api.push.apple.com";
export const APNS_MAX_PAYLOAD = 4096;
const TOKEN_TTL_S = 50 * 60; // Apple rejects tokens older than 60 min and throttles refreshes under 20 min

const tokenCache = new Map<string, { jwt: string; iat: number }>();

/** Test hook. */
export function clearApnsTokenCache() {
  tokenCache.clear();
}

export async function apnsProviderToken(env: Env, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) throw new PermanentError("APNs is not configured");
  const cacheKey = `${env.APNS_TEAM_ID}:${env.APNS_KEY_ID}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && now - hit.iat < TOKEN_TTL_S) return hit.jwt;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(env.APNS_KEY_P8) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const jwt = await signJwt("ES256", key, { kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: now });
  tokenCache.set(cacheKey, { jwt, iat: now });
  return jwt;
}

export function apnsPayload(m: Parameters<typeof alertText>[0]): string {
  const high = (m.priority ?? 3) >= 4;
  const aps = { alert: alertText(m), sound: high ? "default" : undefined };
  const overhead = JSON.stringify({ aps, subetha: {} }).length + 64;
  return JSON.stringify({ aps, subetha: trimEnvelope(m, APNS_MAX_PAYLOAD - overhead) });
}

const DEAD_REASONS = ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"];

registerSender("apns", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const jwt = await apnsProviderToken(env);
  const m = job.message;
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": env.APNS_TOPIC!,
    "apns-push-type": "alert",
    "apns-priority": (m.priority ?? 3) >= 4 ? "10" : "5",
    "content-type": "application/json",
  };
  if (m.expires) headers["apns-expiration"] = String(m.expires);
  // No apns-collapse-id (distinct messages must not replace each other) and no apns-id (must be a
  // UUID; APNs assigns one and returns it).
  const base = (env.APNS_ENDPOINT || APNS_DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const r = await fetch(`${base}/3/device/${encodeURIComponent(ep.address)}`, { method: "POST", headers, body: apnsPayload(m), signal: AbortSignal.timeout(10_000) });
  if (r.ok) return { detail: { status: r.status, apns_id: r.headers.get("apns-id") ?? undefined } };
  const text = await r.text();
  let reason = "";
  try { reason = (JSON.parse(text) as { reason?: string }).reason ?? ""; } catch { /* not JSON */ }
  if (r.status === 410 || DEAD_REASONS.includes(reason)) {
    await unverifyEndpoint(env, ep.id);
    throw new PermanentError(`APNs device token rejected (HTTP ${r.status} ${reason})`);
  }
  if (r.status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
    tokenCache.clear(); // mint a fresh provider token on retry
    throw new Error(`APNs HTTP 403 ${reason}`);
  }
  throw httpFailure(r.status, reason || text);
});
