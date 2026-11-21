// Ask what a publish would cost, and how it would be routed, without sending it.
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  // #region snippet
  const est = await se.estimate(topic, "Smoke detected", {
    priority: 5,
    route: { mode: "all", maxCostUsd: 0.05, deny: ["voice"] },
  });
  console.log(`would cost up to $${(est.estimate_usd_micros / 1e6).toFixed(6)}`);
  for (const step of est.plan) console.log(step);
  // #endregion snippet
  return est;
}
