// Fetch cached messages (no long-lived connection), with filters.
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  await se.publish(topic, "disk 91% full", { priority: 4, tags: ["disk"] });
  await se.publish(topic, "routine check ok", { priority: 2 });
  // #region snippet
  const urgent = await se.poll(topic, { since: "1h", priority: [4, 5] });
  for (const m of urgent) console.log(m.id, m.priority, m.message);
  // #endregion snippet
  return urgent;
}
