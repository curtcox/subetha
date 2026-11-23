// Outbound email: Cloudflare Email Service binding (EMAIL) when bound, else Amazon SES v2 (SigV4).
import { hexEncode, utf8 } from "@subetha/sdk/protocol";
import { sha256Hex } from "../crypto.ts";
import type { Env } from "../types.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender, renderText } from "./senders.ts";

export const EMAIL_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(data) as BufferSource));
}

/** AWS Signature V4 for a JSON POST. */
export async function sigv4(opts: { method: string; url: string; body: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; now?: Date }): Promise<Record<string, string>> {
  const u = new URL(opts.url);
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(opts.body);
  const headers: Record<string, string> = { host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash, "content-type": "application/json" };
  const signed = Object.keys(headers).sort();
  const canonical = [opts.method, u.pathname, u.search.slice(1), signed.map((h) => `${h}:${headers[h]}\n`).join(""), signed.join(";"), payloadHash].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
  let k = await hmac(utf8.encode("AWS4" + opts.secretAccessKey), date);
  k = await hmac(k, opts.region);
  k = await hmac(k, opts.service);
  k = await hmac(k, "aws4_request");
  const sig = hexEncode(await hmac(k, toSign));
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${sig}` };
}

function mime(from: string, to: string, subject: string, text: string): string {
  const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...utf8.encode(s)))}?=`);
  return [`From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, `Message-ID: <${crypto.randomUUID()}@subetha.us>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", btoa(String.fromCharCode(...utf8.encode(text))).replace(/.{76}/g, "$&\r\n")].join("\r\n");
}

export async function sendEmail(env: Env, msg: { to: string; subject: string; text: string }): Promise<{ id: string }> {
  if (!EMAIL_RE.test(msg.to)) throw new PermanentError("invalid email address");
  const from = env.EMAIL_FROM ?? "SubEtha <notify@subetha.us>";
  if (env.EMAIL) {
    const { EmailMessage } = await import("cloudflare:email");
    const fromAddr = /<([^>]+)>/.exec(from)?.[1] ?? from;
    await env.EMAIL.send(new EmailMessage(fromAddr, msg.to, mime(from, msg.to, msg.subject, msg.text)));
    return { id: "cloudflare" };
  }
  if (!env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY) throw new PermanentError("email is not configured");
  const region = env.SES_REGION ?? "us-east-1";
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [msg.to] }, Content: { Simple: { Subject: { Data: msg.subject, Charset: "UTF-8" }, Body: { Text: { Data: msg.text, Charset: "UTF-8" } } } } });
  const headers = await sigv4({ method: "POST", url, body, region, service: "ses", accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY });
  const r = await fetch(url, { method: "POST", headers, body });
  const text = await r.text();
  if (!r.ok) throw httpFailure(r.status, text);
  return { id: (JSON.parse(text) as { MessageId: string }).MessageId };
}

registerSender("email", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const m = job.message;
  const subject = m.enc ? `[${job.topic}] encrypted message` : m.title ?? `[${job.topic}] ${(m.message ?? "").slice(0, 60)}`;
  const text = `${renderText({ ...m, title: undefined })}\n\n${m.click ? `${m.click}\n\n` : ""}— sent via SubEtha to ${job.topic}. Manage: ${env.BASE_URL}/console/`;
  const r = await sendEmail(env, { to: ep.address, subject, text });
  return { detail: r };
});
