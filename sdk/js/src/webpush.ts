// Browser helper for Web Push: subscribe a service worker registration with the relay's VAPID key
// (GET /v1/config → vapid_public_key) and get the address for
// POST /v1/endpoints {"kind": "webpush", "address": <returned string>}.
import { base64urlDecode, base64urlEncode } from "./protocol/index.ts";

// Structural types so the SDK type-checks outside the DOM (Workers, Node).
interface PushSubscriptionLike {
  options?: { applicationServerKey?: ArrayBuffer | null };
  unsubscribe(): Promise<boolean>;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
}
export interface ServiceWorkerRegistrationLike {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<PushSubscriptionLike>;
  };
}

/**
 * Returns the PushSubscription JSON string ({endpoint, keys: {p256dh, auth}}). Reuses an existing
 * subscription made with the same key; replaces one made with a different key. Call it from a user
 * gesture so the browser can ask for notification permission.
 */
export async function subscribeWebPush(registration: ServiceWorkerRegistrationLike, vapidPublicKey: string): Promise<string> {
  const key = base64urlDecode(vapidPublicKey);
  let sub = await registration.pushManager.getSubscription();
  const current = sub?.options?.applicationServerKey;
  if (sub && current && base64urlEncode(new Uint8Array(current)) !== base64urlEncode(key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("push subscription is missing endpoint or keys");
  return JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
}
