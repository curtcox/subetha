// Endpoint inspector (PLAN §10 "webhook/endpoint inspector"): send one test message to an
// endpoint right now and show what happened. For webhooks the response holds the exact request
// the relay sent (headers, signature, body) and what the receiver answered, so integrators can
// debug their signature check without waiting for a real publish. For the other transports it
// reports the provider outcome (message id, segments, error).
//
// A test is a real delivery, so it costs one delivery of that transport (paid before sending,
// charged whether or not the receiver accepts it: the relay did the work either way).
import type { Context, Hono } from "hono";
import { isTopic, ulid, type Envelope } from "@subetha/sdk/protocol";
import { actionPriceMicros, skuForTransport, type PriceTable } from "@subetha/pricing";
import prices from "@subetha/pricing/prices.json";
import { accountTier, audit } from "./accounts.ts";
import { actorOf, requireAdmin } from "./auth.ts";
import { accountStub } from "./durable/account.ts";
import { ApiError } from "./errors.ts";
import { checkTelephonyCircuit } from "./cron.ts";
import { telephonyUnitPrice } from "./control.ts";
import { senders } from "./delivery/index.ts";
import { loadEndpoint } from "./delivery/senders.ts";
import { checkWebhookResponse, sendWebhook, webhookRequest } from "./delivery/webhook.ts";
import { renderText, smsBody, smsSegments, voiceMinutes } from "./delivery/units.ts";
import type { DeliveryJob, Env, Principal } from "./types.ts";

const PRICES = prices as unknown as PriceTable;
type Vars = { Bindings: Env; Variables: { principal: Principal } };
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

export const INSPECT_BODY_MAX = 4096;
const DEFAULT_TOPIC = "@subetha/inspector";

interface TestBody { topic?: unknown; title?: unknown; message?: unknown; priority?: unknown; tags?: unknown }

/** The sample message a test sends; fields the caller gives replace the defaults. */
export function testMessage(b: TestBody, now = Date.now()): Envelope {
  if (b.topic !== undefined && !isTopic(b.topic)) throw new ApiError("bad_request", "topic is not a valid topic name");
  const str = (v: unknown, name: string, max: number) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length > max) throw new ApiError("bad_request", `${name} must be a string of at most ${max} characters`);
    return v;
  };
  const priority = b.priority === undefined ? 3 : b.priority;
  if (!Number.isInteger(priority) || (priority as number) < 1 || (priority as number) > 5) throw new ApiError("bad_request", "priority must be 1..5");
  if (b.tags !== undefined && !(Array.isArray(b.tags) && b.tags.length <= 10 && b.tags.every((t) => typeof t === "string" && t.length <= 64))) throw new ApiError("bad_request", "tags must be up to 10 short strings");
  const topic = (b.topic as string | undefined) ?? DEFAULT_TOPIC;
  return {
    id: ulid(now),
    time: Math.floor(now / 1000),
    event: "message",
    topic,
    title: str(b.title, "title", 256) ?? "SubEtha test",
    message: str(b.message, "message", 1000) ?? "Test delivery from the SubEtha endpoint inspector.",
    priority: priority as Envelope["priority"],
    tags: (b.tags as string[] | undefined) ?? ["test"],
  };
}

/** Billable units for a transport (SMS segments, call minutes), as the publish planner counts them. */
function units(kind: string, m: Envelope): number {
  if (kind === "sms") return smsSegments(smsBody(m));
  if (kind === "voice") return voiceMinutes(renderText(m, 1500));
  return 1;
}

async function readBody(r: Response): Promise<{ body: string; truncated: boolean }> {
  const text = await r.text().catch(() => "");
  return text.length > INSPECT_BODY_MAX ? { body: text.slice(0, INSPECT_BODY_MAX), truncated: true } : { body: text, truncated: false };
}

export function registerInspectorRoutes(app: Hono<Vars>, principal: PrincipalFn) {
  app.post("/v1/endpoints/:id/test", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const raw = await c.req.text();
    let body: TestBody = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw) as TestBody; } catch { throw new ApiError("bad_request", "body must be JSON"); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("bad_request", "body must be a JSON object");
    }
    const row = await c.env.DB.prepare("SELECT id, kind, verified_at FROM endpoints WHERE id = ? AND account_id = ?").bind(c.req.param("id"), accountId).first<{ id: string; kind: string; verified_at: number | null }>();
    if (!row) throw new ApiError("not_found");
    if (!row.verified_at) throw new ApiError("forbidden", "verify the endpoint before testing it");
    const ep = await loadEndpoint(c.env, row.id);
    const message = testMessage(body);
    const telephony = ep.kind === "sms" || ep.kind === "voice" || ep.kind === "whatsapp";
    if (telephony && (await checkTelephonyCircuit(c.env, accountId))) throw new ApiError("provider_unavailable", "SMS and voice are temporarily paused");
    const send = senders[ep.kind];
    const sku = skuForTransport(PRICES, ep.kind);
    if (!send || !sku) throw new ApiError("bad_request", `${ep.kind} endpoints can't be tested`);

    // Numbers outside the US are priced per destination (and must still be enabled for the account).
    const tier = await accountTier(c.env, accountId);
    const price = ep.kind === "sms" || ep.kind === "voice" || ep.kind === "whatsapp"
      ? (await telephonyUnitPrice(c.env, accountId, ep.kind, ep.address)) * units(ep.kind, message)
      : actionPriceMicros(PRICES, sku, tier, units(ep.kind, message));
    const ref = `test:${ep.id}:${message.id}`;
    const account = accountStub(c.env, accountId);
    const tokenId = p.kind === "token" ? p.tokenId : null;
    const caps = p.kind === "token" ? { tokenDaily: p.caps.daily, tokenTotal: p.caps.total } : {};
    const r = await account.reserve(price, ref, tokenId, caps, telephony ? "telephony" : null, `sku=${sku}`);
    if (!r.ok) {
      if (r.code === "insufficient_balance") throw new ApiError("insufficient_balance", "balance can't cover the test delivery", { shortfall_usd_micros: r.shortfall });
      if (r.cap === "account_paused") throw new ApiError("topic_paused", "account is paused");
      throw new ApiError("spend_cap_exceeded", `spend cap reached (${r.cap})`, { cap: r.cap });
    }

    const started = Date.now();
    const out: Record<string, unknown> = { endpoint: { id: ep.id, kind: ep.kind }, message, charged_usd_micros: price };
    let deferSettle = false;
    try {
      if (ep.kind === "webhook") {
        const req = await webhookRequest(ep.address, String(ep.cfg.secret ?? ""), message.topic!, message);
        out.request = req;
        const res = await sendWebhook(req);
        const { body: resBody, truncated } = await readBody(res.clone());
        out.response = { status: res.status, headers: Object.fromEntries(res.headers), body: resBody, truncated };
        await checkWebhookResponse(res);
        out.detail = { status: res.status };
      } else {
        const job: DeliveryJob = { topic: message.topic!, owner: accountId, message, sub: { id: `test_${ep.id}`, transport: ep.kind, endpoint: ep.id }, reservation: { ref, micros: price }, attempt: 0 };
        const res = await send(job, c.env);
        out.detail = res.detail;
        if (res.costMicros !== undefined) out.charged_usd_micros = Math.min(res.costMicros, price);
        deferSettle = !!res.deferSettle;
      }
      out.result = "delivered";
    } catch (e) {
      out.result = "failed";
      out.error = String((e as Error).message ?? e).slice(0, 500);
    }
    out.latency_ms = Date.now() - started;
    // Voice settles from the provider's status callback, to the real call length.
    if (!deferSettle) await account.settle(ref, out.charged_usd_micros as number);
    await audit(c.env, accountId, actorOf(p), "endpoint.test", { id: ep.id, kind: ep.kind, result: out.result });
    return c.json(out);
  });
}
