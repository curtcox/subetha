// The message envelope (spec §2) plus validation, E2EE (§5), and dedupe (§6).

import { canonicalEnvelope, canonicalize, type Json } from "./canonical.ts";
import { base64urlDecode, base64urlEncode, utf8 } from "./encoding.ts";
import { DEVICE_ID_RE } from "./sign.ts";
import { TOPIC_RE } from "./topic.ts";
import { ULID_RE } from "./ulid.ts";
import { xchachaOpen, xchachaSeal } from "./xchacha.ts";

export const TRANSPORTS = [
  "ws", "sse", "poll", "webpush", "apns", "fcm", "webhook", "email", "slack",
  "sms", "voice", "whatsapp", "mcp", "lxmf", "ble", "audio", "qr", "lan",
] as const;
export type Transport = (typeof TRANSPORTS)[number];
export const EDGE_TRANSPORTS: readonly Transport[] = ["ble", "audio", "qr", "lan"];
export type RouteMode = "any" | "fast" | "all" | "cheap";

export interface Action { action: "view" | "http" | "broadcast"; label: string; url?: string; clear?: boolean; [k: string]: unknown }
export interface Attachment { name: string; url: string; size?: number; type?: string; expires?: number }
export interface Route { mode?: RouteMode; max_cost_usd_micros?: number; deny?: Transport[]; allow?: Transport[]; deadline_s?: number }
export interface Enc { alg: "xchacha20poly1305"; kid: string; nonce: string }

export interface Envelope {
  id?: string;
  time?: number;
  expires?: number;
  event?: "message" | "open" | "keepalive" | "poll_request";
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  icon?: string;
  actions?: Action[];
  attachment?: Attachment;
  content_type?: "text/plain" | "text/markdown" | "application/json" | "application/octet-stream";
  sender?: string;
  sig?: string;
  enc?: Enc;
  route?: Route;
  hops?: number;
  [k: string]: unknown;
}

export const MAX_MESSAGE_BYTES = 4096;
const CONTENT_TYPES = ["text/plain", "text/markdown", "application/json", "application/octet-stream"];

const isInt = (v: unknown, min = -Infinity, max = Infinity) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const isStr = (v: unknown, max = Infinity) => typeof v === "string" && utf8.encode(v).length <= max;

/** Validates an envelope against the v0 schema. Returns a list of problems (empty = valid). */
export function validateEnvelope(env: unknown): string[] {
  const errs: string[] = [];
  if (typeof env !== "object" || env === null || Array.isArray(env)) return ["envelope must be an object"];
  const e = env as Record<string, unknown>;
  const opt = (k: string, ok: (v: unknown) => boolean, why: string) => {
    if (e[k] !== undefined && e[k] !== null && !ok(e[k])) errs.push(`${k}: ${why}`);
  };
  if (typeof e.topic !== "string" || !TOPIC_RE.test(e.topic)) errs.push("topic: invalid topic name");
  opt("id", (v) => typeof v === "string" && ULID_RE.test(v), "must be a ULID");
  opt("time", (v) => isInt(v, 0), "must be a non-negative integer");
  opt("expires", (v) => isInt(v, 0), "must be a non-negative integer");
  opt("event", (v) => ["message", "open", "keepalive", "poll_request"].includes(v as string), "unknown event");
  opt("title", (v) => isStr(v, 256), "string up to 256 bytes");
  opt("message", (v) => isStr(v, MAX_MESSAGE_BYTES), `string up to ${MAX_MESSAGE_BYTES} bytes`);
  opt("priority", (v) => isInt(v, 1, 5), "integer 1..5");
  opt("tags", (v) => Array.isArray(v) && v.length <= 16 && v.every((t) => isStr(t, 64)), "up to 16 strings");
  opt("click", (v) => isStr(v, 2048), "string");
  opt("icon", (v) => isStr(v, 2048), "string");
  opt("actions", (v) => Array.isArray(v) && v.length <= 3 && v.every((a) => {
    if (typeof a !== "object" || a === null) return false;
    const act = a as Action;
    return ["view", "http", "broadcast"].includes(act.action) && typeof act.label === "string" &&
      (act.url === undefined || isStr(act.url, 2048)) &&
      (act.clear === undefined || typeof act.clear === "boolean");
  }), "up to 3 actions with action and label");
  opt("attachment", (v) => {
    if (typeof v !== "object" || v === null) return false;
    const att = v as Attachment;
    return typeof att.name === "string" && typeof att.url === "string" &&
      (att.size === undefined || isInt(att.size, 0)) &&
      (att.type === undefined || typeof att.type === "string") &&
      (att.expires === undefined || isInt(att.expires, 0));
  }, "needs name and url");
  opt("content_type", (v) => CONTENT_TYPES.includes(v as string), "unsupported content type");
  opt("sender", (v) => typeof v === "string" && DEVICE_ID_RE.test(v), "must be a device id");
  opt("sig", (v) => typeof v === "string" && /^ed25519:[A-Za-z0-9_-]{86}$/.test(v), "must be ed25519:<base64url>");
  opt("enc", (v) => {
    const x = v as Enc;
    return typeof v === "object" && v !== null && x.alg === "xchacha20poly1305" && typeof x.kid === "string" && x.kid.length > 0 && x.kid.length <= 64 && /^[A-Za-z0-9_-]{32}$/.test(x.nonce);
  }, "invalid enc block");
  opt("route", (v) => {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Route;
    const ts = (a: unknown) => a === undefined || (Array.isArray(a) && a.every((t) => (TRANSPORTS as readonly string[]).includes(t)));
    return (r.mode === undefined || ["any", "fast", "all", "cheap"].includes(r.mode)) &&
      (r.max_cost_usd_micros === undefined || isInt(r.max_cost_usd_micros, 0)) &&
      (r.deadline_s === undefined || isInt(r.deadline_s, 1)) && ts(r.deny) && ts(r.allow);
  }, "invalid route block");
  opt("hops", (v) => isInt(v, 0, 16), "integer 0..16");
  // Integers only, anywhere (spec §2).
  try {
    canonicalize(e as Json);
  } catch (err) {
    errs.push(`envelope: ${(err as Error).message}`);
  }
  return errs;
}

export const PRIORITY_NAMES: Record<string, number> = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };

export function parsePriority(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = v.trim().toLowerCase();
  if (s in PRIORITY_NAMES) return PRIORITY_NAMES[s];
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  throw new Error(`invalid priority: ${v}`);
}

// ---- E2EE (spec §5) ----

export const PROTECTED_FIELDS = ["title", "message", "attachment", "click", "actions", "content_type"] as const;

/** Associated data for E2EE (spec §5): canonical envelope without message, sender, sig, hops. */
export function e2eeAad(env: Envelope): Uint8Array {
  const { message: _m, sender: _s, ...rest } = env;
  return utf8.encode(canonicalEnvelope(rest));
}

export async function encryptEnvelope(env: Envelope, key: Uint8Array, kid: string, nonce?: Uint8Array): Promise<Envelope> {
  if (env.enc) throw new Error("already encrypted");
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(24));
  const prot: Record<string, unknown> = {};
  const out: Envelope = { ...env };
  for (const f of PROTECTED_FIELDS) {
    if (env[f] !== undefined) {
      prot[f] = env[f];
      delete out[f];
    }
  }
  delete out.sig;
  out.enc = { alg: "xchacha20poly1305", kid, nonce: base64urlEncode(n) };
  const aad = e2eeAad(out);
  const ct = xchachaSeal(key, n, utf8.encode(canonicalize(prot as Json)), aad);
  out.message = base64urlEncode(ct);
  return out;
}

/** Returns the decrypted envelope, or null if the key is wrong or the message was tampered with. */
export async function decryptEnvelope(env: Envelope, key: Uint8Array): Promise<Envelope | null> {
  if (!env.enc || typeof env.message !== "string") return null;
  const { message, ...rest } = env;
  const aad = e2eeAad(env);
  const pt = xchachaOpen(key, base64urlDecode(env.enc.nonce), base64urlDecode(message), aad);
  if (!pt) return null;
  const prot = JSON.parse(utf8.decode(pt)) as Record<string, unknown>;
  const out: Envelope = { ...rest, ...prot } as Envelope;
  delete out.enc;
  return out;
}

// ---- Dedupe (spec §6) ----

export class Deduper {
  private seen = new Map<string, number>();
  private readonly capacity: number;
  constructor(capacity = 10_000) {
    this.capacity = capacity;
  }

  /** Returns true if the message is new and should be delivered. */
  accept(env: Pick<Envelope, "id" | "expires">, nowSec = Math.floor(Date.now() / 1000)): boolean {
    if (env.expires !== undefined && env.expires < nowSec) return false;
    if (!env.id) return true;
    const id = env.id.toUpperCase();
    if (this.seen.has(id)) return false;
    this.seen.set(id, env.expires ?? Number.MAX_SAFE_INTEGER);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.seen.has(id.toUpperCase());
  }

  get size(): number {
    return this.seen.size;
  }
}
