// Create a narrowly scoped, spend-capped token for a script or device.
import { SubEtha, SubEthaError } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const admin = new SubEtha({ baseUrl, token, fetch });
  // #region snippet
  const { token: publishOnly } = await admin.createToken({
    name: "backup-script",
    scopes: [`publish:${topic}`],
    transports: ["ws", "sse", "poll", "webpush", "email"], // never SMS or voice
    daily_cap_usd: 0.5,
    expires_in_s: 90 * 86400,
  });

  const script = new SubEtha({ baseUrl, token: publishOnly, fetch });
  await script.publish(topic, "backup ok");                                  // allowed
  const denied = await script.poll(topic).catch((e: SubEthaError) => e.code); // "forbidden"
  // #endregion snippet
  return { denied };
}
