// Enroll a device with the device-code flow, then authenticate with request signatures
// instead of a bearer token.
import { SubEtha, enrollmentProof, generateDeviceKey } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch = globalThis.fetch }: SampleContext) {
  const post = async (path: string, body: unknown, auth?: string) => {
    const r = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, string> };
  };
  // #region snippet
  // On the device: create a key (persist key.seed), prove possession, and get a code.
  const key = await generateDeviceKey();
  const { json: start } = await post("/v1/device/code", { ...(await enrollmentProof(key)), name: "garage-pi", capabilities: ["ws", "lan"] });
  console.log(`Open ${start.verification_uri} and enter ${start.user_code}`);

  // The owner approves the code in the console (or with an admin token):
  await post("/v1/device/approve", { user_code: start.user_code }, token);

  // The device polls every `interval` seconds until it's approved…
  let done = await post("/v1/device/token", { device_code: start.device_code });
  while (done.json.error === "authorization_pending") {
    await new Promise((r) => setTimeout(r, Number(start.interval) * 1000));
    done = await post("/v1/device/token", { device_code: start.device_code });
  }

  // …then signs every request with its key. No bearer token is stored on the device.
  const device = new SubEtha({ baseUrl, fetch, deviceKey: key, signRequests: true });
  const msg = await device.publish(topic, "garage door closed");
  // #endregion snippet
  return { enrolled: done.json.device_id, deviceId: key.deviceId, msg };
}
