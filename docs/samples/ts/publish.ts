// Publish a message with the TypeScript SDK.
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  // #region snippet
  const se = new SubEtha({ baseUrl, token, fetch });
  const msg = await se.publish(topic, "Backup finished in 4m12s", {
    title: "nightly-backup",
    priority: 4,
    tags: ["backup", "white_check_mark"],
    click: "https://example.com/backups/latest",
  });
  console.log(`published ${msg.id} to ${msg.topic}`);
  // #endregion snippet
  return msg;
}
