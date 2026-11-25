// A device enrolled at devicebasedauth.org publishes and subscribes with its DBA credential, and
// can attach an Ed25519 signing key for E2EE topic keys and signed requests.
import { SubEtha, enrollmentProof, generateDeviceKey } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, topic, dba, fetch = globalThis.fetch }: SampleContext) {
  // #region snippet
  // On the device, once: enroll at devicebasedauth.org and have the owner approve it there.
  //   Browser: const dba = new DBA(); await dba.enroll({ aud: ["subetha.us"], grants: [{ actions: ["subetha:publish", "subetha:subscribe"], resources: [topic] }] });
  //   CLI:     dba enroll --aud subetha.us --action subetha:publish --action subetha:subscribe
  // (The owner links that devicebasedauth.org account to their subetha account in the console first.)

  // Every request then carries the device's credential and a fresh proof of its key.
  const url = `${baseUrl}/${topic}`;
  const sent = await fetch(url, { method: "POST", headers: await dba.headers("POST", url), body: "garage door closed" });
  console.log(sent.status); // 200

  // Optional: attach an Ed25519 key, so topic keys can be sealed to the device and it can sign
  // requests and messages. Persist key.seed on the device.
  const key = await generateDeviceKey();
  const attachUrl = `${baseUrl}/v1/devices/dba`;
  await fetch(attachUrl, { method: "POST", headers: { ...(await dba.headers("POST", attachUrl)), "content-type": "application/json" }, body: JSON.stringify({ ...(await enrollmentProof(key)), name: "garage-pi", capabilities: ["ws", "lan"] }) });
  const device = new SubEtha({ baseUrl, fetch, deviceKey: key, signRequests: true });
  const msg = await device.publish(topic, "garage door open");
  // #endregion snippet
  return { status: sent.status, deviceId: key.deviceId, msg };
}
