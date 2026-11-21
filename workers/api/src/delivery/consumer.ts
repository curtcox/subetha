// Queue consumer for paid relay transports. Each job carries a reservation that is settled to the
// actual cost on success and released on permanent failure, so nothing is billed after the fact.
import { accountStub } from "../durable/account.ts";
import { topicStub } from "../durable/topic.ts";
import type { DeliveryJob, Env } from "../types.ts";
import { senders, PermanentError } from "./index.ts";
import { CIRCUIT_KEY } from "../cron.ts";

const MAX_ATTEMPTS = 5;

export async function processJob(job: DeliveryJob, env: Env): Promise<"delivered" | "skipped" | "failed" | "retry"> {
  const topic = topicStub(env, job.topic);
  const account = accountStub(env, job.owner);
  if (job.sub.after_s && (await topic.isAcked(job.message.id!))) {
    await account.release(job.reservation.ref);
    await topic.recordDelivery(job.message.id!, { sub: job.sub.id, transport: job.sub.transport, result: "skipped: acked" });
    return "skipped";
  }
  // A retry after a successful send (bookkeeping failed, or the worker died before acking) must
  // not send again: the send is marked before any bookkeeping.
  if (await topic.wasSent(job.reservation.ref)) {
    await account.settle(job.reservation.ref, job.reservation.micros).catch(() => {});
    return "delivered";
  }
  const send = senders[job.sub.transport];
  let sent = false;
  try {
    if (!send) throw new PermanentError(`no sender for transport ${job.sub.transport}`);
    if (job.sub.transport === "sms" || job.sub.transport === "voice") {
      const circuit = await env.CACHE.get(CIRCUIT_KEY);
      if (circuit) throw new PermanentError(`telephony paused: ${circuit}`);
    }
    const r = await send(job, env);
    sent = true;
    await topic.markSent(job.reservation.ref);
    // Deferred settlement (voice): the provider's status callback settles to the real duration.
    if (!r.deferSettle) await account.settle(job.reservation.ref, Math.min(r.costMicros ?? job.reservation.micros, job.reservation.micros));
    await topic.recordDelivery(job.message.id!, { sub: job.sub.id, transport: job.sub.transport, result: "delivered", detail: r.detail });
    return "delivered";
  } catch (e) {
    if (sent) return "retry"; // bookkeeping failed after sending; the retry only settles
    const permanent = e instanceof PermanentError || job.attempt + 1 >= MAX_ATTEMPTS;
    await topic.recordDelivery(job.message.id!, { sub: job.sub.id, transport: job.sub.transport, result: permanent ? "failed" : "retrying", error: String((e as Error).message ?? e), attempt: job.attempt }).catch(() => {});
    if (permanent) {
      await account.release(job.reservation.ref).catch(() => {});
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
