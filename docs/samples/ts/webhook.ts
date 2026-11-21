// Deliver a topic to your own HTTPS endpoint as signed JSON.
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  // #region snippet
  await se.configureTopic(topic, {}); // the topic must exist, and you must own it
  const ep = await se.request<{ id: string; secret: string }>("POST", "/v1/endpoints", {
    kind: "webhook",
    address: "https://example.com/hooks/subetha",
    name: "my server",
  });
  // ep.secret is shown once. Store it and check X-SubEtha-Signature with it (see verify-webhook.ts).
  const sub = await se.request<{ id: string }>("POST", "/v1/subscriptions", {
    topic,
    endpoint_id: ep.id,
    filter: { tags: ["deploy"] }, // only messages tagged "deploy"
  });
  // #endregion snippet
  return { endpoint: ep, subscription: sub };
}
