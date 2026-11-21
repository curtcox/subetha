// Firebase Cloud Messaging HTTP v1. FCM_SERVICE_ACCOUNT is the service-account JSON downloaded
// from the Firebase console; an OAuth2 access token is minted with the RS256 JWT-bearer grant and
// cached in module scope until shortly before it expires. The endpoint address is the FCM
// registration token. FCM also delivers to iOS (via APNs), which avoids the HTTP/2 issue in apns.ts.
import type { Env } from "../types.ts";
import { alertText, pemToDer, signJwt, trimEnvelope, unverifyEndpoint } from "./push.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender } from "./senders.ts";

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const FCM_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_MAX_DATA = 3000; // FCM caps the whole message at 4 KB; leave room for notification fields

interface ServiceAccount { project_id: string; client_email: string; private_key: string; private_key_id?: string; token_uri?: string }

const tokenCache = new Map<string, { token: string; exp: number }>();

/** Test hook. */
export function clearFcmTokenCache() {
  tokenCache.clear();
}

export function parseServiceAccount(env: Env): ServiceAccount {
  if (!env.FCM_SERVICE_ACCOUNT) throw new PermanentError("FCM is not configured");
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    throw new PermanentError("FCM_SERVICE_ACCOUNT is not valid JSON");
  }
  if (!sa.project_id || !sa.client_email || !sa.private_key) throw new PermanentError("FCM_SERVICE_ACCOUNT is missing project_id, client_email, or private_key");
  return sa;
}

export async function fcmAccessToken(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const cacheKey = `${sa.client_email}:${sa.private_key_id ?? ""}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.exp - 300 > now) return hit.token;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key) as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assertion = await signJwt("RS256", key, { typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }, {
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: FCM_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const r = await fetch(sa.token_uri ?? FCM_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (!r.ok) throw httpFailure(r.status, `OAuth token: ${text}`);
  const j = JSON.parse(text) as { access_token: string; expires_in?: number };
  tokenCache.set(cacheKey, { token: j.access_token, exp: now + (j.expires_in ?? 3600) });
  return j.access_token;
}

interface FcmError { error?: { code?: number; status?: string; message?: string; details?: { "@type"?: string; errorCode?: string; fieldViolations?: { field?: string }[] }[] } }

/** True when FCM says the registration token itself is dead or invalid. */
export function isDeadToken(status: number, body: FcmError): boolean {
  const e = body.error ?? {};
  const codes = (e.details ?? []).map((d) => d.errorCode).filter(Boolean);
  if (status === 404 || e.status === "NOT_FOUND" || codes.includes("UNREGISTERED") || codes.includes("SENDER_ID_MISMATCH")) return true;
  if (e.status === "INVALID_ARGUMENT" || codes.includes("INVALID_ARGUMENT")) {
    const fields = (e.details ?? []).flatMap((d) => d.fieldViolations ?? []).map((f) => f.field ?? "");
    return fields.some((f) => /token/i.test(f)) || /registration token|message\.token/i.test(e.message ?? "");
  }
  return false;
}

export function fcmMessage(token: string, m: Parameters<typeof alertText>[0]) {
  const high = (m.priority ?? 3) >= 4;
  const ttl = m.expires ? Math.max(0, m.expires - Math.floor(Date.now() / 1000)) : undefined;
  return {
    message: {
      token,
      notification: alertText(m),
      data: { subetha: JSON.stringify(trimEnvelope(m, FCM_MAX_DATA)) },
      android: { priority: high ? "high" : "normal", ...(ttl !== undefined ? { ttl: `${ttl}s` } : {}) },
      apns: {
        headers: { "apns-priority": high ? "10" : "5", ...(m.expires ? { "apns-expiration": String(m.expires) } : {}) },
        payload: { aps: high ? { sound: "default" } : {} },
      },
    },
  };
}

registerSender("fcm", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const sa = parseServiceAccount(env);
  const token = await fcmAccessToken(sa);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(fcmMessage(ep.address, job.message)),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (r.ok) return { detail: { name: (JSON.parse(text) as { name?: string }).name } };
  let body: FcmError = {};
  try { body = JSON.parse(text) as FcmError; } catch { /* not JSON */ }
  if (isDeadToken(r.status, body)) {
    await unverifyEndpoint(env, ep.id);
    throw new PermanentError(`FCM token rejected (HTTP ${r.status}): ${body.error?.message ?? text.slice(0, 200)}`);
  }
  if (r.status === 401) {
    tokenCache.clear(); // stale access token: mint a new one on retry
    throw new Error(`FCM HTTP 401: ${text.slice(0, 200)}`);
  }
  throw httpFailure(r.status, text);
});
