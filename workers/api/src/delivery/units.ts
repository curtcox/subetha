// Billable units for telephony transports. Pure (no provider calls), so the site's pricing
// calculator and route simulator can bundle it (apps/site/src/tools.ts).
import type { Envelope } from "@subetha/sdk/protocol";

/** SKU for one MMS to a US number; the planner uses it instead of SMS segments when it applies. */
export const MMS_SKU = "deliver_mms_us";
/** Twilio accepts JPEG, PNG and GIF up to 5 MB on every US carrier. */
export const MMS_MAX_BYTES = 5 * 1024 * 1024;
export const MMS_MAX_CHARS = 1600;

/**
 * The image an SMS subscriber gets as an MMS, or null for a plain SMS: the attachment must be an
 * unencrypted JPEG, PNG or GIF of known size up to MMS_MAX_BYTES (Twilio fetches it by URL).
 */
export function mmsMedia(m: Pick<Envelope, "attachment" | "enc">): string | null {
  const a = m.attachment;
  if (m.enc || !a?.url || !/^https?:\/\//.test(a.url) || !a.type || !/^image\/(jpeg|png|gif)$/i.test(a.type)) return null;
  return typeof a.size === "number" && a.size > 0 && a.size <= MMS_MAX_BYTES ? a.url : null;
}

/** Human-readable rendering used by text transports (email, SMS, voice, Slack). */
export function renderText(m: Pick<Envelope, "title" | "message" | "enc">, max = Infinity): string {
  const body = m.enc ? "[encrypted message — open in a SubEtha app]" : (m.message ?? "");
  const s = m.title ? `${m.title}: ${body}` : body;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

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
