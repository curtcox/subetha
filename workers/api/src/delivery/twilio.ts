// Twilio SMS and voice (US only for now; PLAN §6, §8 fraud protection).
import { base64urlEncode, utf8 } from "@subetha/sdk/protocol";
import { timingSafeEqual } from "../crypto.ts";
import type { Env } from "../types.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender, renderText } from "./senders.ts";

export const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€\f";

/** Number of SMS segments Twilio will bill for this text. */
export function smsSegments(text: string): number {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.includes(ch)) septets += 1;
    else if (GSM7_EXT.includes(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  const units = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

/** Calls are capped at CALL_TIME_LIMIT_S and the text is spoken twice plus a gather, so the
 * reservation covers the whole limit; the status callback settles to the real duration. */
export const CALL_TIME_LIMIT_S = 180;
export function voiceMinutes(_text: string): number {
  return CALL_TIME_LIMIT_S / 60;
}

export const SMS_MAX_CHARS = 459; // 3 GSM segments
export const smsBody = (m: Parameters<typeof renderText>[0]) => renderText(m, SMS_MAX_CHARS);

function twilioAuth(env: Env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) throw new PermanentError("Twilio is not configured");
  return { sid: env.TWILIO_ACCOUNT_SID, auth: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, from: env.TWILIO_FROM };
}

export async function sendSms(env: Env, to: string, body: string): Promise<{ sid: string; segments: number }> {
  if (!US_E164.test(to)) throw new PermanentError("only US numbers are supported");
  const t = twilioAuth(env);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: t.auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: t.from, Body: body }).toString(),
  });
  const text = await r.text();
  if (!r.ok) throw httpFailure(r.status, text);
  const j = JSON.parse(text) as { sid: string; num_segments?: string };
  return { sid: j.sid, segments: Number(j.num_segments ?? smsSegments(body)) };
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export function voiceTwiml(text: string, ackUrl: string | null): string {
  const say = `<Say voice="Polly.Joanna">${xml(text)}</Say>`;
  if (!ackUrl) return `<Response>${say}</Response>`;
  return `<Response><Gather numDigits="1" timeout="8" action="${xml(ackUrl)}" method="POST">${say}<Say>Press 1 to acknowledge.</Say></Gather>${say}</Response>`;
}

export async function makeCall(env: Env, to: string, twiml: string, statusCallback?: string): Promise<{ sid: string }> {
  if (!US_E164.test(to)) throw new PermanentError("only US numbers are supported");
  const t = twilioAuth(env);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Calls.json`, {
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
