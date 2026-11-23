// Hand an E2EE topic key to enrolled devices through the relay (spec §5.1). The key is sealed to
// each device's identity key, so the relay stores it but can't read it.
import { SubEtha, enrollmentProof, generateDeviceKey } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch = globalThis.fetch }: SampleContext) {
  // A device enrolled into the account (see devices.ts for the device-code flow).
  const deviceKey = await generateDeviceKey();
  await fetch(`${baseUrl}/v1/devices`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(await enrollmentProof(deviceKey)) });

  // #region snippet
  // Owner (admin token): create the topic, then wrap a fresh key for each device that should read it.
  const owner = new SubEtha({ baseUrl, token, fetch });
  await owner.configureTopic(topic, {});
  const key = crypto.getRandomValues(new Uint8Array(32));
  await owner.shareTopicKey(topic, "2026-11", key, [deviceKey.deviceId]);

  const sender = new SubEtha({ baseUrl, token, fetch, topicKeys: { [topic]: { kid: "2026-11", key } } });
  await sender.publish(topic, "Gate code is 0451");

  // Device: fetch and open its wrapped keys with a signed request, then read as usual.
  const device = new SubEtha({ baseUrl, fetch, deviceKey, signRequests: true });
  await device.loadTopicKeys();
  const [msg] = await device.poll(topic);
  console.log(msg!.message); // "Gate code is 0451"
  // #endregion snippet
  return { msg: msg!, wrapped: (await owner.listWrappedKeys(topic)).keys };
}
