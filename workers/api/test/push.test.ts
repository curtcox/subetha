import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64urlDecode, base64urlEncode, concatBytes, utf8, type Envelope } from "@subetha/sdk/protocol";
import { processJob } from "../src/delivery/consumer.ts";
import { trimEnvelope } from "../src/delivery/push.ts";
import { encryptWebPush, generateVapidKeys, importP256Private, vapidAuthorization, WEBPUSH_MAX_PAYLOAD } from "../src/delivery/webpush.ts";
import { clearFcmTokenCache, FCM_SCOPE } from "../src/delivery/fcm.ts";
import { clearApnsTokenCache } from "../src/delivery/apns.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";
import { reserve } from "./reserve.ts";

const E = env as unknown as Env;
const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; headers: Record<string, string>; body: Uint8Array };
function stubProviders(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    const req = new Request(input, init);
    const c: Call = { url, headers: Object.fromEntries(req.headers), body: new Uint8Array(await req.arrayBuffer()) };
    calls.push(c);
    return handler(c);
  });
  return calls;
}

const bs = (b: Uint8Array) => b as BufferSource;
const text = (b: Uint8Array) => utf8.decode(b);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(info) }, key, bytes * 8));
}

/** Independent RFC 8291 receiver: parse the aes128gcm header, derive keys, decrypt, unpad. */
async function decryptWebPush(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, authSecret: Uint8Array): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  expect(ct.length).toBeLessThanOrEqual(rs);
  const asKey = await crypto.subtle.importKey("raw", bs(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, uaPrivate, 256));
  const prkKey = await crypto.subtle.importKey("raw", bs(authSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, bs(ecdh)));
  // HKDF-Expand by hand (one block) for the first step, to cross-check WebCrypto's HKDF in the sender.
  const ikmKey = await crypto.subtle.importKey("raw", bs(prk), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ikm = new Uint8Array(await crypto.subtle.sign("HMAC", ikmKey, bs(concatBytes(utf8.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])))));
  const cek = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", bs(cek), "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(nonce) }, key, bs(ct)));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2); // last-record delimiter
  return padded.slice(0, end);
}

async function uaKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { priv: kp.privateKey, pub, auth: crypto.getRandomValues(new Uint8Array(16)) };
}

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split(".") as [string, string, string];
  return { header: JSON.parse(text(base64urlDecode(h))), claims: JSON.parse(text(base64urlDecode(c))), sig: base64urlDecode(s), input: utf8.encode(`${h}.${c}`) };
}

function toPem(der: ArrayBuffer, label = "PRIVATE KEY") {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

/** Account + topic + endpoint + subscription + reservation, ready for processJob. */
async function setup(handle: string, kind: string, address: string, msg: Partial<Envelope> = {}) {
  const a = await bootstrap(handle, 1);
  const topic = `@${handle}/push`;
  await publish(topic, "init", auth(a.token));
  const r = await SELF.fetch(`${BASE}/v1/endpoints`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ kind, address }) });
  expect(r.status).toBe(201);
  const ep = (await r.json()) as { id: string; verified: boolean };
  expect(ep.verified).toBe(true);
  const s = await SELF.fetch(`${BASE}/v1/subscriptions`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ topic, endpoint_id: ep.id }) });
  expect(s.status).toBe(201);
  const job = async (): Promise<DeliveryJob> => ({
    topic, owner: a.account_id,
    message: { topic, id: "01JD00000000000000000000AB", title: "Door", message: "front door opened", priority: 4, ...msg },
    sub: { id: "s", transport: kind as DeliveryJob["sub"]["transport"], endpoint: ep.id },
    reservation: { ref: await reserve(E, a.account_id, 1000), micros: 1000 }, attempt: 0,
  });
  const verified = async () => {
    const list = (await (await SELF.fetch(`${BASE}/v1/endpoints`, { headers: auth(a.token) })).json()) as { endpoints: { id: string; verified: boolean }[] };
    return list.endpoints.find((e) => e.id === ep.id)!.verified;
  };
  return { a, ep, job, verified };
}

describe("push payload trimming", () => {
  it("keeps small envelopes intact and trims big ones, dropping large fields first", () => {
    const small: Envelope = { topic: "@a/b", id: "x", message: "hi" };
    expect(trimEnvelope(small, 3800)).toBe(small);
    const big: Envelope = { topic: "@a/b", id: "x", title: "T", priority: 5, message: "m".repeat(1000), click: "https://c.example", actions: [{ action: "view", label: "x".repeat(3000), url: "https://x" }] as Envelope["actions"], icon: "i".repeat(500) };
    const t = trimEnvelope(big, 1200);
    expect(utf8.encode(JSON.stringify(t)).length).toBeLessThanOrEqual(1200);
    expect(t).toMatchObject({ id: "x", topic: "@a/b", title: "T", priority: 5, message: big.message, click: big.click, truncated: true });
    expect(t.actions).toBeUndefined();
    expect(t.icon).toBeUndefined();
  });
  it("shortens the message (UTF-8 safely) when the kept fields alone are too large", () => {
    const t = trimEnvelope({ topic: "@a/b", id: "x", message: "日\"".repeat(2000), tags: ["a"] }, WEBPUSH_MAX_PAYLOAD);
    const n = utf8.encode(JSON.stringify(t)).length;
    expect(n).toBeLessThanOrEqual(WEBPUSH_MAX_PAYLOAD);
    expect(n).toBeGreaterThan(WEBPUSH_MAX_PAYLOAD - 20);
    expect(t.message!.endsWith("…")).toBe(true);
    expect(t.tags).toBeUndefined();
  });
});

describe("Web Push encryption (RFC 8291)", () => {
  it("round-trips with fixed keys and salt, deterministically", async () => {
    const ua = await uaKeys();
    const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const asKeys = {
      publicKey: new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer),
      privateKey: base64urlDecode(((await crypto.subtle.exportKey("jwk", as.privateKey)) as JsonWebKey).d!),
    };
    const salt = new Uint8Array(16).fill(7);
    const pt = utf8.encode(JSON.stringify({ topic: "@a/b", message: "hello ☃" }));
    const body = await encryptWebPush(pt, ua.pub, ua.auth, { asKeys, salt });
    expect(body.slice(0, 16)).toEqual(salt);
    expect(body.slice(21, 86)).toEqual(asKeys.publicKey);
    expect(body.length).toBe(86 + pt.length + 1 + 16);
    expect(await encryptWebPush(pt, ua.pub, ua.auth, { asKeys, salt })).toEqual(body);
    expect(text(await decryptWebPush(body, ua.priv, ua.pub, ua.auth))).toBe(text(pt));
    // A fresh ephemeral key and salt each time by default.
    const b2 = await encryptWebPush(pt, ua.pub, ua.auth);
    expect(b2.slice(0, 86)).not.toEqual(body.slice(0, 86));
    expect(text(await decryptWebPush(b2, ua.priv, ua.pub, ua.auth))).toBe(text(pt));
  });

  it("matches the RFC 8291 Appendix A example", async () => {
    const d = (s: string) => base64urlDecode(s);
    const uaPublic = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    const asKeys = { publicKey: d("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"), privateKey: d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") };
    const authSecret = d("BTBZMqHH6r4Tts7J_aSIgg");
    const salt = d("DGv6ra1nlYgDCS1FRnbzlw");
    const plaintext = d("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
    const expected = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
    expect(text(plaintext)).toBe("When I grow up, I want to be a watermelon");
    expect(base64urlEncode(await encryptWebPush(plaintext, uaPublic, authSecret, { asKeys, salt }))).toBe(expected);
    const uaPriv = await importP256Private(d("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), uaPublic, "ECDH");
    expect(text(await decryptWebPush(d(expected), uaPriv, uaPublic, authSecret))).toBe(text(plaintext));
  });

  it("signs VAPID JWTs with raw r||s ES256", async () => {
    const keys = await generateVapidKeys();
    expect(base64urlDecode(keys.publicKey)).toHaveLength(65);
    expect(base64urlDecode(keys.privateKey)).toHaveLength(32);
    const now = Math.floor(Date.now() / 1000);
    const h = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" }, now);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(m[2]).toBe(keys.publicKey);
    const jwt = decodeJwt(m[1]!);
    expect(jwt.header).toEqual({ alg: "ES256", typ: "JWT" });
    expect(jwt.claims).toEqual({ aud: "https://fcm.googleapis.com", exp: now + 43200, sub: "mailto:ops@example.com" });
    expect(jwt.sig).toHaveLength(64);
    const pub = await crypto.subtle.importKey("raw", bs(base64urlDecode(keys.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, bs(jwt.sig), bs(jwt.input))).toBe(true);
  });
});

describe("webpush sender", () => {
  it("delivers an encrypted, VAPID-signed push and retires gone subscriptions", async () => {
    const ua = await uaKeys();
    const vapid = await generateVapidKeys();
    const address = JSON.stringify({ endpoint: "https://push.example.net/wp/abc123", keys: { p256dh: base64urlEncode(ua.pub), auth: base64urlEncode(ua.auth) } });
    const s = await setup("pusher", "webpush", address, { expires: Math.floor(Date.now() / 1000) + 600, click: "https://example.com/door", tags: ["door"] });
    const envx = { ...E, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" } as Env;

    const calls = stubProviders(() => new Response(null, { status: 201, headers: { location: "https://push.example.net/m/1" } }));
    expect(await processJob(await s.job(), envx)).toBe("delivered");
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://push.example.net/wp/abc123");
    expect(c.headers).toMatchObject({ "content-encoding": "aes128gcm", urgency: "high", topic: "01JD00000000000000000000AB" });
    expect(Number(c.headers.ttl)).toBeGreaterThan(590);
    expect(Number(c.headers.ttl)).toBeLessThanOrEqual(600);
    expect(c.headers.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
    expect(decodeJwt(/t=([^,]+)/.exec(c.headers.authorization!)![1]!).claims.aud).toBe("https://push.example.net");
    const env2 = JSON.parse(text(await decryptWebPush(c.body, ua.priv, ua.pub, ua.auth)));
    expect(env2).toMatchObject({ id: "01JD00000000000000000000AB", title: "Door", message: "front door opened", click: "https://example.com/door", tags: ["door"], priority: 4 });

    stubProviders(() => new Response("busy", { status: 503 }));
    expect(await processJob(await s.job(), envx)).toBe("retry");
    stubProviders(() => new Response("rate", { status: 429 }));
    expect(await processJob(await s.job(), envx)).toBe("retry");

    stubProviders(() => new Response("gone", { status: 410 }));
    expect(await processJob(await s.job(), envx)).toBe("failed");
    expect(await s.verified()).toBe(false);
    const again = stubProviders(() => new Response(null, { status: 201 }));
    expect(await processJob(await s.job(), envx)).toBe("failed"); // endpoint no longer used
    expect(again).toHaveLength(0);
  });

  it("maps priority to Urgency and fails permanently without VAPID keys", async () => {
    const ua = await uaKeys();
    const address = JSON.stringify({ endpoint: "https://push.example.net/wp/low", keys: { p256dh: base64urlEncode(ua.pub), auth: base64urlEncode(ua.auth) } });
    const s = await setup("pusher2", "webpush", address, { priority: 1 });
    const calls = stubProviders(() => new Response(null, { status: 201 }));
    expect(await processJob(await s.job(), E)).toBe("failed");
    expect(calls).toHaveLength(0);
    const vapid = await generateVapidKeys();
    expect(await processJob(await s.job(), { ...E, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey } as Env)).toBe("delivered");
    expect(calls[0]!.headers.urgency).toBe("low");
    expect(Number(calls[0]!.headers.ttl)).toBe(86400);
  });

  it("exposes the VAPID public key in /v1/config", async () => {
    const r = (await (await SELF.fetch(`${BASE}/v1/config`)).json()) as Record<string, unknown>;
    expect(r).toHaveProperty("vapid_public_key");
  });
});

describe("fcm sender", () => {
  it("mints an RS256 OAuth token (cached) and sends HTTP v1 messages; retires unregistered tokens", async () => {
    clearFcmTokenCache();
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const sa = { type: "service_account", project_id: "subetha-test", private_key_id: "kid1", client_email: "relay@subetha-test.iam.gserviceaccount.com", private_key: toPem((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer) };
    const envx = { ...E, FCM_SERVICE_ACCOUNT: JSON.stringify(sa) } as Env;
    const token = "fcm-token_" + "x".repeat(140);
    const s = await setup("fcmer", "fcm", token, { priority: 5 });

    let tokenCalls = 0;
    const calls = stubProviders(async (c) => {
      if (c.url === "https://oauth2.googleapis.com/token") {
        tokenCalls++;
        const form = new URLSearchParams(text(c.body));
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        const jwt = decodeJwt(form.get("assertion")!);
        expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid1" });
        expect(jwt.claims).toMatchObject({ iss: sa.client_email, scope: FCM_SCOPE, aud: "https://oauth2.googleapis.com/token" });
        expect(jwt.claims.exp - jwt.claims.iat).toBe(3600);
        expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, bs(jwt.sig), bs(jwt.input))).toBe(true);
        return Response.json({ access_token: "ya29.test", expires_in: 3599, token_type: "Bearer" });
      }
      return Response.json({ name: "projects/subetha-test/messages/1" });
    });
    expect(await processJob(await s.job(), envx)).toBe("delivered");
    expect(await processJob(await s.job(), envx)).toBe("delivered");
    expect(tokenCalls).toBe(1);
    const sends = calls.filter((c) => c.url.startsWith("https://fcm.googleapis.com/"));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.url).toBe("https://fcm.googleapis.com/v1/projects/subetha-test/messages:send");
    expect(sends[0]!.headers.authorization).toBe("Bearer ya29.test");
    const body = JSON.parse(text(sends[0]!.body));
    expect(body.message).toMatchObject({ token, notification: { title: "Door", body: "front door opened" }, android: { priority: "high" }, apns: { headers: { "apns-priority": "10" } } });
    expect(JSON.parse(body.message.data.subetha)).toMatchObject({ id: "01JD00000000000000000000AB", topic: "@fcmer/push", message: "front door opened" });

    stubProviders(() => Response.json({ error: { code: 500, status: "INTERNAL", message: "x" } }, { status: 500 }));
    expect(await processJob(await s.job(), envx)).toBe("retry");
    expect(await s.verified()).toBe(true);

    stubProviders(() => Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid JSON payload received. Unknown name \"foo\"" } }, { status: 400 }));
    expect(await processJob(await s.job(), envx)).toBe("failed");
    expect(await s.verified()).toBe(true); // a bad payload is not a bad token

    stubProviders(() => Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } }, { status: 404 }));
    expect(await processJob(await s.job(), envx)).toBe("failed");
    expect(await s.verified()).toBe(false);
  });

  it("retires tokens FCM calls invalid", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const sa = { project_id: "p2", client_email: "r2@p2.iam.gserviceaccount.com", private_key: toPem((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer) };
    const s = await setup("fcmer2", "fcm", "bad-token-" + "y".repeat(30), { priority: 3 });
    const calls = stubProviders((c) => c.url.includes("oauth2")
      ? Response.json({ access_token: "t2", expires_in: 3600 })
      : Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }, { status: 400 }));
    expect(await processJob(await s.job(), { ...E, FCM_SERVICE_ACCOUNT: JSON.stringify(sa) } as Env)).toBe("failed");
    expect(JSON.parse(text(calls[1]!.body)).message.android.priority).toBe("normal");
    expect(await s.verified()).toBe(false);
  });
});

describe("apns sender", () => {
  async function apnsEnv() {
    clearApnsTokenCache();
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const envx = { ...E, APNS_KEY_P8: toPem((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer), APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "us.subetha.app", APNS_ENDPOINT: "https://apns-relay.example.com/", APNS_RELAY_SECRET: "relay-secret-0123456789" } as Env;
    return { kp, envx };
  }

  it("signs a provider token and posts an alert with priority and expiration", async () => {
    const { kp, envx } = await apnsEnv();
    const device = "a1".repeat(32);
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const s = await setup("apnser", "apns", device, { priority: 5, expires });
    const calls = stubProviders(() => new Response(null, { status: 200, headers: { "apns-id": "11111111-2222-3333-4444-555555555555" } }));
    expect(await processJob(await s.job(), envx)).toBe("delivered");
    const c = calls[0]!;
    expect(c.url).toBe(`https://apns-relay.example.com/3/device/${device}`);
    expect(c.headers).toMatchObject({ "apns-topic": "us.subetha.app", "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(expires) });
    expect(c.headers["apns-collapse-id"]).toBeUndefined();
    expect(c.headers["x-relay-secret"]).toBe("relay-secret-0123456789");
    const jwt = decodeJwt(c.headers.authorization!.replace(/^bearer /, ""));
    expect(jwt.header).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(jwt.claims.iss).toBe("TEAM123456");
    expect(jwt.sig).toHaveLength(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, bs(jwt.sig), bs(jwt.input))).toBe(true);
    const body = JSON.parse(text(c.body));
    expect(body.aps).toEqual({ alert: { title: "Door", body: "front door opened" }, sound: "default" });
    expect(body.subetha).toMatchObject({ id: "01JD00000000000000000000AB", topic: "@apnser/push", priority: 5 });

    // Token is cached; low priority omits sound and uses apns-priority 5.
    const s2 = await setup("apnser2", "apns", "b2".repeat(32), { priority: 2 });
    const calls2 = stubProviders(() => new Response(null, { status: 200 }));
    expect(await processJob(await s2.job(), envx)).toBe("delivered");
    expect(calls2[0]!.headers.authorization).toBe(c.headers.authorization);
    expect(calls2[0]!.headers["apns-priority"]).toBe("5");
    expect(calls2[0]!.headers["apns-expiration"]).toBeUndefined();
    expect(JSON.parse(text(calls2[0]!.body)).aps).toEqual({ alert: { title: "Door", body: "front door opened" } });
  });

  it("retires bad or unregistered device tokens and retries throttling", async () => {
    const { envx } = await apnsEnv();
    const s = await setup("apnser3", "apns", "c3".repeat(32));
    stubProviders(() => Response.json({ reason: "TooManyRequests" }, { status: 429 }));
    expect(await processJob(await s.job(), envx)).toBe("retry");
    stubProviders(() => Response.json({ reason: "BadDeviceToken" }, { status: 400 }));
    expect(await processJob(await s.job(), envx)).toBe("failed");
    expect(await s.verified()).toBe(false);

    const s2 = await setup("apnser4", "apns", "d4".repeat(32));
    stubProviders(() => Response.json({ reason: "Unregistered", timestamp: 1 }, { status: 410 }));
    expect(await processJob(await s2.job(), envx)).toBe("failed");
    expect(await s2.verified()).toBe(false);
  });

  it("fails permanently when APNs is not configured", async () => {
    const s = await setup("apnser5", "apns", "e5".repeat(32));
    const calls = stubProviders(() => new Response(null, { status: 200 }));
    expect(await processJob(await s.job(), E)).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("BYO push credentials (PLAN §6)", () => {
  it("validates, stores write-only, and delivers APNs with account default, sandbox, and pinned credentials", async () => {
    clearApnsTokenCache();
    const a = await bootstrap("byoapns", 2);
    const b = await bootstrap("byoapns2", 1);
    const topic = "@byoapns/push";
    await publish(topic, "init", auth(a.token));

    // Rejects invalid key_p8 and key_id.
    const bad = await SELF.fetch(`${BASE}/v1/push/credentials`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "apns", key_id: "BAD", team_id: "TEAM123456", topic: "com.acme.app", key_p8: "not-a-key" }),
    });
    expect(bad.status).toBe(400);

    const kpProd = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pemProd = toPem((await crypto.subtle.exportKey("pkcs8", kpProd.privateKey)) as ArrayBuffer);
    const c1r = await SELF.fetch(`${BASE}/v1/push/credentials`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "apns", name: "Acme Prod", key_id: "BYOKEY0001", team_id: "BYOTEAM001", topic: "com.acme.app", key_p8: pemProd }),
    });
    expect(c1r.status).toBe(201);
    const c1 = (await c1r.json()) as Record<string, unknown>;
    expect(c1).toMatchObject({ kind: "apns", name: "Acme Prod", is_default: true, key_id: "BYOKEY0001", team_id: "BYOTEAM001", topic: "com.acme.app", sandbox: false });
    expect(c1.key_p8).toBeUndefined();

    // GET never returns private keys.
    const list = (await (await SELF.fetch(`${BASE}/v1/push/credentials`, { headers: auth(a.token) })).json()) as { credentials: Record<string, unknown>[] };
    expect(list.credentials).toHaveLength(1);
    expect(list.credentials[0]!.key_p8).toBeUndefined();

    // Endpoint without explicit credential_id uses account default even when operator env is empty.
    const ep1 = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "apns", address: "a1".repeat(32) }),
    })).json()) as { id: string };
    const calls = stubProviders(() => new Response(null, { status: 200 }));
    const job1: DeliveryJob = {
      topic, owner: a.account_id,
      message: { topic, id: "01JD00000000000000000000B1", title: "Hi", message: "byo", priority: 4 },
      sub: { id: "s1", transport: "apns", endpoint: ep1.id },
      reservation: { ref: await reserve(E, a.account_id, 1000), micros: 1000 }, attempt: 0,
    };
    expect(await processJob(job1, E)).toBe("delivered");
    expect(calls[0]!.url).toBe(`https://api.push.apple.com/3/device/${"a1".repeat(32)}`);
    expect(calls[0]!.headers["apns-topic"]).toBe("com.acme.app");
    const jwt1 = decodeJwt(calls[0]!.headers.authorization!.replace(/^bearer /, ""));
    expect(jwt1.header.kid).toBe("BYOKEY0001");
    expect(jwt1.claims.iss).toBe("BYOTEAM001");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kpProd.publicKey, bs(jwt1.sig), bs(jwt1.input))).toBe(true);

    // Second sandbox credential, explicitly pinned on an endpoint.
    const kpDev = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pemDev = toPem((await crypto.subtle.exportKey("pkcs8", kpDev.privateKey)) as ArrayBuffer);
    const c2 = (await (await SELF.fetch(`${BASE}/v1/push/credentials`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "apns", name: "Acme Dev", key_id: "BYOKEY0002", team_id: "BYOTEAM002", topic: "com.acme.app.dev", sandbox: true, key_p8: pemDev }),
    })).json()) as { id: string; is_default: boolean; sandbox: boolean };
    expect(c2.is_default).toBe(false);
    expect(c2.sandbox).toBe(true);

    // Another account cannot pin c2.
    const steal = await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(b.token), body: JSON.stringify({ kind: "apns", address: "b2".repeat(32), credential_id: c2.id }),
    });
    expect(steal.status).toBe(404);

    const ep2 = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "apns", address: "b2".repeat(32), credential_id: c2.id }),
    })).json()) as { id: string; credential_id: string };
    expect(ep2.credential_id).toBe(c2.id);

    const calls2 = stubProviders(() => new Response(null, { status: 200 }));
    const job2: DeliveryJob = {
      topic, owner: a.account_id,
      message: { topic, id: "01JD00000000000000000000B2", title: "Dev", message: "sandbox", priority: 3 },
      sub: { id: "s2", transport: "apns", endpoint: ep2.id },
      reservation: { ref: await reserve(E, a.account_id, 1000), micros: 1000 }, attempt: 0,
    };
    expect(await processJob(job2, E)).toBe("delivered");
    expect(calls2[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${"b2".repeat(32)}`);
    expect(calls2[0]!.headers["apns-topic"]).toBe("com.acme.app.dev");

    // Deleting a pinned credential fails permanently (does NOT silently fall back).
    expect((await SELF.fetch(`${BASE}/v1/push/credentials/${c2.id}`, { method: "DELETE", headers: auth(a.token) })).status).toBe(200);
    const calls3 = stubProviders(() => new Response(null, { status: 200 }));
    const job3: DeliveryJob = { ...job2, reservation: { ref: await reserve(E, a.account_id, 1000), micros: 1000 } };
    expect(await processJob(job3, E)).toBe("failed");
    expect(calls3).toHaveLength(0);
  });

  it("validates and delivers FCM using BYO service account JSON and blocks custom token_uri", async () => {
    clearFcmTokenCache();
    const a = await bootstrap("byofcm", 2);
    const topic = "@byofcm/push";
    await publish(topic, "init", auth(a.token));

    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const sa = {
      type: "service_account", project_id: "acme-mobile-app", private_key_id: "byokid",
      client_email: "push@acme-mobile-app.iam.gserviceaccount.com",
      private_key: toPem((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer),
    };

    // Rejects non-Google token_uri (SSRF defense).
    const ssrf = await SELF.fetch(`${BASE}/v1/push/credentials`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "fcm", service_account: { ...sa, token_uri: "https://evil.example/token" } }),
    });
    expect(ssrf.status).toBe(400);

    const cr = await SELF.fetch(`${BASE}/v1/push/credentials`, {
      method: "POST", headers: auth(a.token),
      body: JSON.stringify({ kind: "fcm", name: "Acme Firebase", service_account: JSON.stringify(sa) }),
    });
    expect(cr.status).toBe(201);
    const cred = (await cr.json()) as Record<string, unknown>;
    expect(cred).toMatchObject({ kind: "fcm", name: "Acme Firebase", is_default: true, project_id: "acme-mobile-app", client_email: sa.client_email });
    expect(cred.private_key).toBeUndefined();

    const ep = (await (await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST", headers: auth(a.token), body: JSON.stringify({ kind: "fcm", address: "byo-fcm-token-" + "z".repeat(40) }),
    })).json()) as { id: string };

    const calls = stubProviders((c) => c.url.includes("oauth2.googleapis.com")
      ? Response.json({ access_token: "ya29.byo", expires_in: 3600 })
      : Response.json({ name: "projects/acme-mobile-app/messages/99" }));
    const job: DeliveryJob = {
      topic, owner: a.account_id,
      message: { topic, id: "01JD00000000000000000000B3", title: "Ping", message: "hello fcm", priority: 4 },
      sub: { id: "s3", transport: "fcm", endpoint: ep.id },
      reservation: { ref: await reserve(E, a.account_id, 1000), micros: 1000 }, attempt: 0,
    };
    expect(await processJob(job, E)).toBe("delivered");
    expect(calls.find((c) => c.url.includes("fcm.googleapis.com"))!.url).toBe("https://fcm.googleapis.com/v1/projects/acme-mobile-app/messages:send");
  });
});
