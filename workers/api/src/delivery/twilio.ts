// Twilio SMS and voice: US numbers, plus opt-in countries priced per destination (PLAN §6, §8).
import { base64urlEncode, utf8 } from "@subetha/sdk/protocol";
import { timingSafeEqual } from "../crypto.ts";
import type { Env } from "../types.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender, renderText } from "./senders.ts";
import { CALL_TIME_LIMIT_S, MMS_MAX_BYTES, MMS_MAX_CHARS, MMS_SKU, mmsMedia, smsBody, smsSegments } from "./units.ts";
import { phoneCountry } from "./destinations.ts";

export { CALL_TIME_LIMIT_S, MMS_SKU, mmsMedia, SMS_MAX_CHARS, smsBody, smsSegments, voiceMinutes } from "./units.ts";


function twilioAuth(env: Env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) throw new PermanentError("Twilio is not configured");
  // TWILIO_API_BASE points local end-to-end tests at a mock; production leaves it unset.
  const base = (env.TWILIO_API_BASE || "https://api.twilio.com").replace(/\/+$/, "");
  return { base, sid: env.TWILIO_ACCOUNT_SID, auth: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, from: env.TWILIO_FROM };
}

/** Sends an SMS, or an MMS when `mediaUrl` is given (Twilio fetches the image from it). */
export async function sendSms(env: Env, to: string, body: string, mediaUrl?: string): Promise<{ sid: string; segments: number }> {
  if (!phoneCountry(to)) throw new PermanentError("unsupported destination");
  const t = twilioAuth(env);
  const r = await fetch(`${t.base}/2010-04-01/Accounts/${t.sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: t.auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: t.from, Body: body, ...(mediaUrl ? { MediaUrl: mediaUrl } : {}) }).toString(),
  });
  const text = await r.text();
  if (!r.ok) throw httpFailure(r.status, text);
  const j = JSON.parse(text) as { sid: string; num_segments?: string };
  return { sid: j.sid, segments: Number(j.num_segments ?? smsSegments(body)) };
}

/**
 * Downloads the picture from an inbound MMS (Twilio's MediaUrl0). Only URLs on Twilio's API host
 * are fetched, since the request carries the account's credentials; only JPEG, PNG and GIF up to
 * MMS_MAX_BYTES are kept. Returns null for anything else.
 */
export async function fetchInboundMedia(env: Env, url: string): Promise<{ bytes: Uint8Array; type: string; name: string } | null> {
  const t = twilioAuth(env);
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== new URL(t.base).origin || !u.pathname.startsWith(`/2010-04-01/Accounts/${t.sid}/Messages/`)) return null;
  const r = await fetch(u.toString(), { headers: { authorization: t.auth }, redirect: "follow" });
  if (!r.ok) return null;
  const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif" } as Record<string, string>)[type];
  if (!ext || Number(r.headers.get("content-length") ?? 0) > MMS_MAX_BYTES) { await r.body?.cancel(); return null; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  return bytes.length && bytes.length <= MMS_MAX_BYTES ? { bytes, type, name: `mms.${ext}` } : null;
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export function voiceTwiml(text: string, ackUrl: string | null): string {
  const say = `<Say voice="Polly.Joanna">${xml(text)}</Say>`;
  if (!ackUrl) return `<Response>${say}</Response>`;
  return `<Response><Gather numDigits="1" timeout="8" action="${xml(ackUrl)}" method="POST">${say}<Say>Press 1 to acknowledge.</Say></Gather>${say}</Response>`;
}

export async function makeCall(env: Env, to: string, twiml: string, statusCallback?: string): Promise<{ sid: string }> {
  if (!phoneCountry(to)) throw new PermanentError("unsupported destination");
  const t = twilioAuth(env);
  const r = await fetch(`${t.base}/2010-04-01/Accounts/${t.sid}/Calls.json`, {
    method: "POST",
    headers: { authorization: t.auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: t.from, Twiml: twiml, TimeLimit: String(CALL_TIME_LIMIT_S), ...(statusCallback ? { StatusCallback: statusCallback, StatusCallbackEvent: "completed" } : {}) }).toString(),
  });
  const text = await r.text();
  if (!r.ok) throw httpFailure(r.status, text);
  return { sid: (JSON.parse(text) as { sid: string }).sid };
}

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(k+v for POST params))). */
export async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", utf8.encode(authToken) as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(data) as BufferSource));
  return btoa(String.fromCharCode(...mac));
}

export async function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null): Promise<boolean> {
  if (!header) return false;
  return timingSafeEqual(await twilioSignature(authToken, url, params), header);
}

/** Signed, expiring token embedded in the voice ack URL so only Twilio's callback can ack. */
export async function ackToken(secret: string, topic: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(`ack:${topic}:${id}`) as BufferSource));
  return base64urlEncode(mac.slice(0, 16));
}

registerSender("sms", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  // Planned as an MMS: one message with the picture, at the reserved MMS price.
  const media = job.sku === MMS_SKU ? mmsMedia(job.message) : null;
  if (media) {
    const r = await sendSms(env, ep.address, renderText(job.message, MMS_MAX_CHARS), media);
    return { costMicros: job.reservation.micros, detail: { sid: r.sid, mms: true } };
  }
  const r = await sendSms(env, ep.address, smsBody(job.message));
  // Reservation was for the estimated segments; settle to what Twilio reports (never more).
  const perSegment = Math.floor(job.reservation.micros / Math.max(1, smsSegments(smsBody(job.message))));
  return { costMicros: perSegment * r.segments, detail: { sid: r.sid, segments: r.segments } };
});

registerSender("voice", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const secret = env.TWILIO_AUTH_TOKEN ?? "";
  const ack = `${env.BASE_URL}/v1/hooks/twilio/voice-ack?topic=${encodeURIComponent(job.topic)}&id=${job.message.id}&t=${await ackToken(secret, job.topic, job.message.id!)}`;
  const res = job.reservation;
  const status = `${env.BASE_URL}/v1/hooks/twilio/voice-status?acct=${encodeURIComponent(job.owner)}&ref=${encodeURIComponent(res.ref)}&max=${res.micros}&t=${await ackToken(secret, job.owner, `${res.ref}:${res.micros}`)}`;
  const r = await makeCall(env, ep.address, voiceTwiml(renderText(job.message, 1500), ack), status);
  return { detail: { sid: r.sid }, deferSettle: true };
});
