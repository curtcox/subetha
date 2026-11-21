import { app } from "./app.ts";
import { handleDeliveryBatch } from "./delivery/consumer.ts";
import type { DeliveryJob, Env } from "./types.ts";

export { AccountDO } from "./durable/account.ts";
export { TopicDO } from "./durable/topic.ts";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<DeliveryJob>, env: Env, ctx: ExecutionContext) {
    await handleDeliveryBatch(batch, env, ctx);
  },
  async scheduled(_evt: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Cron jobs: storage metering, reconciliation, Twilio repricing (see src/cron.ts once added).
  },
} satisfies ExportedHandler<Env, DeliveryJob>;
