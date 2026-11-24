// Inbound email: <handle>.<name>@in.subetha.us or t_…@in.subetha.us → publish (PLAN §6).
// Charged to the topic owner as inbound_email + publish; senders must be allowed by the topic's
// email_senders policy.
import { isTopic, utf8 } from "@subetha/sdk/protocol";
import { actionPriceMicros, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { accountTier } from "./accounts.ts";
import { accountStub } from "./durable/account.ts";
import { topicStub } from "./durable/topic.ts";
import type { Env } from "./types.ts";
import { sha256Hex } from "./crypto.ts";
import { emitMetric, estimatedCostMicros } from "./telemetry.ts";

const PRICES = prices as unknown as PriceTable;
const MAX_RAW = 512 * 1024;

export function topicFromAddress(to: string): string | null {
  const local = to.split("@")[0]!.toLowerCase();
  if (local.startsWith("t_")) return isTopic(local) ? local : null;
  const dot = local.indexOf(".");
  if (dot < 1) return null;
  // Names may contain upper case; email local parts are case-insensitive in practice, so the
  // original case is recovered from the To header by the caller when possible.
  const topic = `@${local.slice(0, dot)}/${to.split("@")[0]!.slice(dot + 1)}`;
  return isTopic(topic) ? topic : null;
}

function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, text: string) => {
    const bytes = enc.toLowerCase() === "b"
      ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
      : qpBytes(text.replace(/_/g, " "));
    return utf8.decode(bytes);
  });
}

function qpBytes(s: string): Uint8Array {
  const out: number[] = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...utf8.encode(t[i]!));
  }
  return new Uint8Array(out);
}

interface Part { headers: Record<string, string>; body: string }

function splitPart(raw: string): Part {
  const idx = raw.search(/\r?\n\r?\n/);
  const head = idx < 0 ? raw : raw.slice(0, idx);
  const body = idx < 0 ? "" : raw.slice(idx).replace(/^\r?\n\r?\n/, "");
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, body };
}

function decodeBody(p: Part): string {
  const cte = (p.headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (cte === "base64") {
    try { return utf8.decode(Uint8Array.from(atob(p.body.replace(/\s+/g, "")), (c) => c.charCodeAt(0))); } catch { return ""; }
  }
  if (cte === "quoted-printable") return utf8.decode(qpBytes(p.body));
  return p.body;
}

function findPlainText(p: Part, depth = 0): string | null {
  const ct = p.headers["content-type"] ?? "text/plain";
  if (/^text\/plain/i.test(ct)) return decodeBody(p);
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (/^multipart\//i.test(ct) && boundary && depth < 5) {
    const parts = p.body.split(`--${boundary}`).slice(1).filter((x) => !x.startsWith("--"));
    for (const raw of parts) {
      const t = findPlainText(splitPart(raw.replace(/^\r?\n/, "")), depth + 1);
      if (t !== null) return t;
    }
  }
  return null;
}

function findHtmlText(p: Part, depth = 0): string | null {
  const ct = p.headers["content-type"] ?? "text/plain";
  if (/^text\/html/i.test(ct)) return decodeBody(p).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (/^multipart\//i.test(ct) && boundary && depth < 5) {
    const parts = p.body.split(`--${boundary}`).slice(1).filter((x) => !x.startsWith("--"));
    for (const raw of parts) {
      const t = findHtmlText(splitPart(raw.replace(/^\r?\n/, "")), depth + 1);
      if (t !== null) return t;
    }
  }
  return null;
}

function findText(p: Part): string | null {
  return findPlainText(p) ?? findHtmlText(p);
}

export function parseEmail(raw: string): { subject: string; from: string; text: string } {
  const top = splitPart(raw);
  const text = (findText(top) ?? "").replace(/\r\n/g, "\n").trim();
  // Drop quoted replies and signatures, keep it short.
  const trimmed = text.split(/\n(?:-- \n|On .+ wrote:\n|>)/)[0]!.trim();
  return { subject: decodeWords(top.headers.subject ?? ""), from: top.headers.from ?? "", text: trimmed };
}

export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (env.INBOUND_EMAIL_DOMAIN) {
    const domain = (message.to.split("@")[1] ?? "").toLowerCase();
    if (domain !== env.INBOUND_EMAIL_DOMAIN.toLowerCase()) return message.setReject("unknown inbound email domain");
  }
  const topic = topicFromAddress(message.to);
  if (!topic) return message.setReject("unknown topic address");
  if (message.rawSize > MAX_RAW) return message.setReject("message too large");
  const meta = await topicStub(env, topic).getMeta();
  const from = message.from.toLowerCase();
  const wildcard = !!meta?.policy.email_senders?.includes("*");
  const allowed = meta?.policy.email_senders?.some((s) => s === "*" || s.toLowerCase() === from || (s.startsWith("@") && from.endsWith(s.toLowerCase())));
  if (!meta || !allowed) return message.setReject("sender not allowed for this topic");
  if (meta.policy.paused) return message.setReject("topic is paused");
  if (!wildcard) {
    const authRes = (message.headers.get("authentication-results") ?? "").toLowerCase();
    if (/\bdmarc=fail\b/.test(authRes) || /\bspf=fail\b/.test(authRes)) {
      return message.setReject("sender failed SPF/DMARC authentication");
    }
  }
  const raw = await new Response(message.raw).text();
  const parsed = parseEmail(raw);
  // Message-ID is sender-controlled, so scope it to the sender and topic.
  const msgId = await sha256Hex(`${topic}\n${from}\n${message.headers.get("message-id") ?? `${Date.now()}`}`);
  const inPrice = actionPriceMicros(PRICES, "inbound_email", await accountTier(env, meta.owner));
  const charge = await accountStub(env, meta.owner).charge(inPrice, `inmail:${msgId}`, null, {}, true, "sku=inbound_email");
  if (!charge.ok) return message.setReject("topic owner's balance is empty");
  emitMetric(env, { accountId: meta.owner, event: "inbound_email", transport: "email", sku: "inbound_email", revenueMicros: inPrice, providerCostMicros: estimatedCostMicros("inbound_email"), detail: topic });
  const r = await topicStub(env, topic).publish({
    envelope: { topic, title: parsed.subject.slice(0, 256) || undefined, message: (parsed.text || "(no text)").slice(0, 4096), tags: ["email"], email_from: from } as never,
    caller: { accountId: meta.owner, tokenId: null, deviceId: null, caps: { daily: null, total: null }, transports: null },
    autoCreateOwner: null, idempotencyKey: `email:${msgId}`, bodyHash: msgId, dryRun: false,
    route: { mode: "any", maxCost: null, deny: ["email"], allow: null },
  });
  if (!r.ok) message.setReject(r.error.message);
}
