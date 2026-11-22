// A gateway bridges an offline device (Bluetooth only) to the relay, in both directions.
import { SubEtha, type Envelope } from "@subetha/sdk";
import { BleLink, bridgeEdge, GossipNode } from "@subetha/sdk/edge";
import { ulid } from "@subetha/sdk/protocol";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  const offline: Envelope[] = [];

  // #region snippet
  // The gateway (a phone with internet) and an offline device, linked over BLE.
  const gateway = new GossipNode();
  const device = new GossipNode();
  device.subscribe(topic);

  let toDevice!: BleLink;
  const toGateway = new BleLink(device, (chunk) => toDevice.receive(chunk), (m) => offline.push(m));
  toDevice = new BleLink(gateway, (chunk) => toGateway.receive(chunk), (m) => void bridge.uplink(m));

  const bridge = bridgeEdge(se, gateway, {
    topics: [topic],
    hops: 1,
    since: "10m",                              // catch up on what was missed while offline
    transport: "stream",
    onDownlink: () => void toDevice.resync(), // tell the device something new arrived
  });

  // Offline device → gateway → relay.
  const now = Math.floor(Date.now() / 1000);
  device.publish({ id: ulid(), time: now, expires: now + 600, topic, message: "Battery low", hops: 1 });
  await toGateway.resync();

  // Relay → gateway → offline device.
  await se.publish(topic, "Firmware update available");
  // #endregion snippet

  for (let i = 0; i < 100 && offline.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  let onRelay = await se.poll(topic);
  for (let i = 0; i < 50 && onRelay.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 20));
    onRelay = await se.poll(topic);
  }
  bridge.close();
  return { offline, onRelay };
}
