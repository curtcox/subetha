// Apple Push Notification service with provider-token (JWT) auth. The endpoint address is the
// hex device token.
//
// HTTP/2 caveat: APNs only speaks HTTP/2, and a Worker's outbound fetch() is not guaranteed to
// negotiate HTTP/2 with api.push.apple.com. Operators run gateways/apns-relay (HTTP/1.1 in,
// HTTP/2 out) and set APNS_ENDPOINT to it, with APNS_RELAY_SECRET sent as x-relay-secret; or
// deliver to iOS through FCM instead (fcm.ts), which talks to APNs on our behalf.
import type { Env } from "../types.ts";
import { resolvePushCredential, type ApnsCredentialConfig } from "../push-credentials.ts";
import { alertText, pemToDer, signJwt, trimEnvelope, unverifyEndpoint } from "./push.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender } from "./senders.ts";

export const APNS_DEFAULT_ENDPOINT = "https://api.push.apple.com";
export const APNS_SANDBOX_DEFAULT_ENDPOINT = "https://api.sandbox.push.apple.com";
export const APNS_MAX_PAYLOAD = 4096;
const TOKEN_TTL_S = 50 * 60; // Apple rejects tokens older than 60 min and throttles refreshes under 20 min

const tokenCache = new Map<string, { jwt: string; iat: number }>();

/** Test hook. */
export function clearApnsTokenCache() {
  tokenCache.clear();
}

export async function apnsProviderTokenFor(creds: ApnsCredentialConfig, cacheScope = "env", now = Math.floor(Date.now() / 1000)): Promise<string> {
  const cacheKey = `${cacheScope}:${creds.team_id}:${creds.key_id}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && now - hit.iat < TOKEN_TTL_S) return hit.jwt;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(creds.key_p8) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const jwt = await signJwt("ES256", key, { kid: creds.key_id }, { iss: creds.team_id, iat: now });
  tokenCache.set(cacheKey, { jwt, iat: now });
  return jwt;
}

export async function apnsProviderToken(env: Env, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) throw new PermanentError("APNs is not configured");
  return apnsProviderTokenFor({ key_p8: env.APNS_KEY_P8, key_id: env.APNS_KEY_ID, team_id: env.APNS_TEAM_ID, topic: env.APNS_TOPIC }, "env", now);
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
  const byo = await resolvePushCredential<ApnsCredentialConfig>(env, ep.account_id, "apns", typeof ep.cfg.credential_id === "string" ? ep.cfg.credential_id : undefined);
  let creds: ApnsCredentialConfig;
  let cacheScope: string;
  if (byo) {
    creds = byo.config;
    cacheScope = byo.id;
  } else {
    if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) throw new PermanentError("APNs is not configured");
    creds = { key_p8: env.APNS_KEY_P8, key_id: env.APNS_KEY_ID, team_id: env.APNS_TEAM_ID, topic: env.APNS_TOPIC, sandbox: false };
    cacheScope = "env";
  }
  const jwt = await apnsProviderTokenFor(creds, cacheScope);
  const m = job.message;
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": creds.topic,
    "apns-push-type": "alert",
    "apns-priority": (m.priority ?? 3) >= 4 ? "10" : "5",
    "content-type": "application/json",
  };
  if (m.expires) headers["apns-expiration"] = String(m.expires);
  const customEndpoint = creds.sandbox ? env.APNS_SANDBOX_ENDPOINT : env.APNS_ENDPOINT;
  if (customEndpoint && env.APNS_RELAY_SECRET) headers["x-relay-secret"] = env.APNS_RELAY_SECRET;
  // No apns-collapse-id (distinct messages must not replace each other) and no apns-id (must be a
  // UUID; APNs assigns one and returns it).
  const base = (customEndpoint || (creds.sandbox ? APNS_SANDBOX_DEFAULT_ENDPOINT : APNS_DEFAULT_ENDPOINT)).replace(/\/+$/, "");
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
    tokenCache.delete(`${cacheScope}:${creds.team_id}:${creds.key_id}`); // mint a fresh provider token on retry
    throw new Error(`APNs HTTP 403 ${reason}`);
  }
  throw httpFailure(r.status, reason || text);
});
