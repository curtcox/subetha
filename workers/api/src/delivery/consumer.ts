// Queue consumer for paid relay transports. Each job carries a reservation that is settled to the
// actual cost on success and released on permanent failure, so nothing is billed after the fact.
import { accountStub } from "../durable/account.ts";
import { topicStub } from "../durable/topic.ts";
import { optedCountries } from "../control.ts";
import type { DeliveryJob, Env } from "../types.ts";
import { senders, PermanentError } from "./index.ts";
import { checkTelephonyCircuit, tripAccountTelephonyCircuit } from "../cron.ts";
import { emitMetric, estimatedCostMicros } from "../telemetry.ts";

const MAX_ATTEMPTS = 5;

export async function processJob(job: DeliveryJob, env: Env): Promise<"delivered" | "skipped" | "failed" | "retry"> {
  const started = Date.now();
  const topic = topicStub(env, job.topic);
  const account = accountStub(env, job.owner);
  const skip = async (reason: string, outcome: string) => {
    await account.release(job.reservation.ref);
    await topic.recordDelivery(job.message.id!, { sub: job.sub.id, transport: job.sub.transport, result: `skipped: ${reason}` });
    emitMetric(env, { accountId: job.owner, event: "delivery", transport: job.sub.transport, sku: job.sku, outcome, latencyMs: Date.now() - started });
    return "skipped" as const;
  };
  if (job.mode !== "all" && (job.sub.after_s || job.attempt > 0) && (await topic.isAcked(job.message.id!))) {
    return skip("acked", "skipped_acked");
  }
  if (job.deadline_ms && Date.now() > job.deadline_ms) {
    return skip("past deadline", "skipped_deadline");
  }
  // A retry after a successful send (bookkeeping failed, or the worker died before acking) must
  // not send again: the send is marked before any bookkeeping.
  if (await topic.wasSent(job.reservation.ref)) {
    await account.settle(job.reservation.ref, job.reservation.micros).catch(() => {});
    return "delivered";
  }
  // Re-check kill switches, freeze, subscription pause/delete, and country opt-out before sending
  // (important for delayed escalation jobs queued up to an hour earlier).
  const acct = await env.DB.prepare("SELECT paused, frozen_since, telephony_countries FROM accounts WHERE id = ?")
    .bind(job.owner).first<{ paused: number; frozen_since: number | null; telephony_countries: string | null }>();
  if (acct?.paused) return skip("account paused", "skipped_paused");
  if (acct?.frozen_since) return skip("account frozen", "skipped_frozen");
  if (job.sub.country && job.sub.country !== "US" && acct && !optedCountries(acct.telephony_countries).includes(job.sub.country)) {
    return skip(`country ${job.sub.country} disabled`, "skipped_policy");
  }
  const meta = await topic.getMeta();
  if (meta?.policy.paused) return skip("topic paused", "skipped_paused");
  if (job.sub.id.startsWith("sub_")) {
    const subRow = await env.DB.prepare("SELECT paused FROM subscriptions WHERE id = ?").bind(job.sub.id).first<{ paused: number }>();
    if (!subRow || subRow.paused) return skip(subRow ? "subscription paused" : "subscription deleted", "skipped_paused");
  }
  const send = senders[job.sub.transport];
  let sent = false;
  try {
    if (!send) throw new PermanentError(`no sender for transport ${job.sub.transport}`);
    const telephony = job.sub.transport === "sms" || job.sub.transport === "voice" || job.sub.transport === "whatsapp";
    if (telephony) {
      const circuit = await checkTelephonyCircuit(env, job.owner);
      if (circuit) throw new PermanentError(`telephony paused: ${circuit}`);
    }
    const r = await send(job, env);
    sent = true;
    await topic.markSent(job.reservation.ref);
    const settled = Math.min(r.costMicros ?? job.reservation.micros, job.reservation.micros);
    // Deferred settlement (voice): the provider's status callback settles to the real duration.
    if (!r.deferSettle) await account.settle(job.reservation.ref, settled);
    const estCost = estimatedCostMicros(job.sku, 1);
    emitMetric(env, {
      accountId: job.owner, event: "delivery", transport: job.sub.transport, sku: job.sku, outcome: "delivered",
      revenueMicros: r.deferSettle ? job.reservation.micros : settled,
      providerCostMicros: estCost,
      latencyMs: Date.now() - started,
    });
    // Per-account margin guard: if a non-deferred telephony delivery settled below estimated provider cost, trip per-account breaker.
    if (telephony && !r.deferSettle && estCost > 0 && settled < estCost && job.sku !== "deliver_sms_intl" && job.sku !== "deliver_voice_intl") {
      await tripAccountTelephonyCircuit(env, job.owner, `telephony settled (${settled} µ$) below cost (${estCost} µ$)`);
    }
    await topic.recordDelivery(job.message.id!, { sub: job.sub.id, transport: job.sub.transport, result: "delivered", detail: r.detail });
    return "delivered";
  } catch (e) {
    if (sent) return "retry"; // bookkeeping failed after sending; the retry only settles
    const pastDeadline = !!job.deadline_ms && Date.now() >= job.deadline_ms;
    const permanent = e instanceof PermanentError || pastDeadline || job.attempt + 1 >= MAX_ATTEMPTS;
    await topic.recordDelivery(job.message.id!, { sub: job.sub.id, transport: job.sub.transport, result: permanent ? "failed" : "retrying", error: String((e as Error).message ?? e), attempt: job.attempt }).catch(() => {});
    if (permanent) {
      await account.release(job.reservation.ref).catch(() => {});
      emitMetric(env, { accountId: job.owner, event: "delivery", transport: job.sub.transport, sku: job.sku, outcome: "failed", latencyMs: Date.now() - started });
      return "failed";
    }
    return "retry";
  }
}

export async function handleDeliveryBatch(batch: MessageBatch<DeliveryJob>, env: Env, _ctx: ExecutionContext) {
  for (const msg of batch.messages) {
    const job = { ...msg.body, attempt: msg.attempts - 1 };
    const r = await processJob(job, env);
    if (r === "retry") msg.retry({ delaySeconds: Math.min(300, 5 * 2 ** job.attempt) });
    else msg.ack();
  }
}
