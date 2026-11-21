import { app } from "./app.ts";
import { handleDeliveryBatch } from "./delivery/consumer.ts";
import { handleInboundEmail } from "./email-inbound.ts";
import { runCron } from "./cron.ts";
import type { DeliveryJob, Env } from "./types.ts";

export { AccountDO } from "./durable/account.ts";
export { TopicDO } from "./durable/topic.ts";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<DeliveryJob>, env: Env, ctx: ExecutionContext) {
    await handleDeliveryBatch(batch, env, ctx);
  },
  async scheduled(evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(evt.cron, env, Date.now()));
  },
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    await handleInboundEmail(message, env);
  },
} satisfies ExportedHandler<Env, DeliveryJob>;
