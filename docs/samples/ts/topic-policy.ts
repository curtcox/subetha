// Let anyone publish to a topic (you pay, within caps), with paid transports restricted.
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch = globalThis.fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  // #region snippet
  await se.configureTopic(topic, {
    public_publish: true,           // anonymous publishes are charged to you…
    anon_rate_per_min: 10,          // …rate limited…
    anon_daily_cap_micros: 200_000, // …and capped at $0.20/day
    deny_transports: ["voice"],
    min_priority: { sms: 4 },       // SMS only for high-priority messages
  });

  // Now no token is needed:
  const r = await fetch(`${baseUrl}/${topic}`, { method: "POST", body: "doorbell rang" });
  // #endregion snippet
  return { status: r.status };
}
