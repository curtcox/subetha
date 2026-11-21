// Per-transport senders for queued (paid) relay deliveries (PLAN §6). Each sender gets the job
// (message + subscription with endpoint id/address) and returns the actual cost if it differs
// from the reservation (e.g. SMS segments). Throw PermanentError for failures that must not be
// retried (4xx, unverified endpoint); any other error is retried with backoff.
import type { Transport } from "@subetha/sdk/protocol";
import type { DeliveryJob, Env } from "../types.ts";

export class PermanentError extends Error {}

export interface SendResult { costMicros?: number; detail?: unknown; /** Leave the reservation open; a provider callback settles it. */ deferSettle?: boolean }
export type Sender = (job: DeliveryJob, env: Env) => Promise<SendResult>;

export interface EndpointRow {
  id: string;
  account_id: string;
  kind: Transport;
  address: string;
  config: string; // JSON, may hold secrets (webhook secret, Slack bot token, push keys)
  verified_at: number | null;
}

export async function loadEndpoint(env: Env, id: string): Promise<EndpointRow & { cfg: Record<string, unknown> }> {
  const row = await env.DB.prepare("SELECT id, account_id, kind, address, config, verified_at FROM endpoints WHERE id = ?").bind(id).first<EndpointRow>();
  if (!row) throw new PermanentError(`endpoint ${id} no longer exists`);
  if (!row.verified_at) throw new PermanentError(`endpoint ${id} is not verified`);
  return { ...row, cfg: JSON.parse(row.config || "{}") };
}

/** Human-readable rendering used by text transports (email, SMS, voice, Slack). */
export function renderText(m: DeliveryJob["message"], max = Infinity): string {
  const body = m.enc ? "[encrypted message — open in a SubEtha app]" : (m.message ?? "");
  const s = m.title ? `${m.title}: ${body}` : body;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function httpFailure(status: number, text: string): Error {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
    ? new PermanentError(`HTTP ${status}: ${text.slice(0, 200)}`)
    : new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
}

const registry: Partial<Record<Transport, Sender>> = {};
export const senders: Partial<Record<Transport, Sender>> = registry;

export function registerSender(t: Transport, s: Sender) {
  registry[t] = s;
}
