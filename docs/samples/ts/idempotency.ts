// Retry safely: the same Idempotency-Key never delivers or charges twice.
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  // #region snippet
  const key = "order-1234-shipped";
  const a = await se.publish(topic, "Order 1234 shipped", { idempotencyKey: key });
  const b = await se.publish(topic, "Order 1234 shipped", { idempotencyKey: key }); // e.g. a retry after a timeout
  console.log(a.id === b.id); // true: one message, charged once
  // #endregion snippet
  return { a, b };
}
