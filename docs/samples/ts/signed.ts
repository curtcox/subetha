// Sign messages with a device key so receivers (and edge relays) can verify the sender.
import { SubEtha, generateDeviceKey, verifyEnvelope } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  // #region snippet
  const deviceKey = await generateDeviceKey(); // persist deviceKey.seed somewhere safe
  const se = new SubEtha({ baseUrl, token, fetch, deviceKey });
  const sent = await se.publish(topic, "Temperature 21.5C"); // signed automatically
  console.log(sent.sender, sent.sig);

  // Any receiver can check the signature: the public key is inside the sender id.
  const [received] = await se.poll(topic);
  console.log("valid:", await verifyEnvelope(received!));
  // #endregion snippet
  return { sent, valid: await verifyEnvelope(received!), deviceId: deviceKey.deviceId };
}
