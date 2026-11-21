// See how a message was routed and what it cost (topic owner only).
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  const msg = await se.publish(topic, "trace me");
  // #region snippet
  const trace = await se.trace(topic, msg.id!);
  console.log(JSON.stringify(trace, null, 2)); // plan, deliveries, acks, µ$ per step
  // #endregion snippet
  return trace;
}
