import { describe, expect, it } from "vitest";
import { encodeBeacon, GossipNode, LanGossip, LAN_DATAGRAM_DATA, parseBeacon } from "../src/edge/index.ts";
import { startLan } from "../src/edge/lan-node.ts";
import { ulid, type Envelope } from "../src/protocol/index.ts";

const TOPIC = "@alice/lan";
const nowS = () => Math.floor(Date.now() / 1000);
const env = (message: string, hops = 2): Envelope => ({ id: ulid(), time: nowS(), expires: nowS() + 600, topic: TOPIC, message, hops });

describe("LAN beacons", () => {
  it("round trip and reject junk", () => {
    const b = encodeBeacon({ node: "0123456789abcdef", port: 5000 });
    expect(parseBeacon(b)).toEqual({ subetha: "lan/1", node: "0123456789abcdef", port: 5000 });
    for (const bad of ['{"subetha":"lan/2","node":"0123456789abcdef","port":1}', '{"subetha":"lan/1","node":"xyz","port":1}', '{"subetha":"lan/1","node":"0123456789abcdef","port":70000}', "nope"]) {
      expect(parseBeacon(new TextEncoder().encode(bad))).toBeNull();
    }
  });
});

describe("LAN gossip (in memory)", () => {
  it("finds peers by beacon and spreads large messages in several datagrams", async () => {
    const hosts = ["10.0.0.1", "10.0.0.2", "10.0.0.3"];
    const inbox: string[][] = hosts.map(() => []);
    const sizes: number[] = [];
    const lans: LanGossip[] = [];
    hosts.forEach((host, i) => {
      const node = new GossipNode();
      node.subscribe(TOPIC);
      lans.push(new LanGossip(node, {
        port: 9000 + i,
        onMessage: (e) => inbox[i]!.push(e.message!),
        send: async (h, p, d) => {
          sizes.push(d.length);
          await lans[hosts.indexOf(h)]!.onDatagram(d, host, 9000 + i);
          expect(p).toBe(9000 + hosts.indexOf(h));
        },
      }));
      (lans[i] as unknown as { node: GossipNode }).node.publish(env(`from ${host} ` + "x".repeat(i === 0 ? 3000 : 10)));
    });
    // Everyone hears everyone's beacon.
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) await lans[j]!.onBeacon(lans[i]!.beacon(), hosts[i]!);
    for (const [i, got] of inbox.entries()) {
      expect(got.length, hosts[i]).toBe(2);
      expect(got.some((m) => m.startsWith(`from ${hosts[i]}`))).toBe(false);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(LAN_DATAGRAM_DATA + 6);
    expect(lans[0]!.peerCount).toBe(2);
    await lans[0]!.onBeacon(lans[0]!.beacon(), hosts[0]!); // our own beacon is ignored
    expect(lans[0]!.peerCount).toBe(2);
  });
});

describe("LAN gossip over UDP", () => {
  it("two nodes on this host find each other by multicast", async () => {
    const a = new GossipNode();
    const b = new GossipNode();
    a.subscribe(TOPIC);
    b.subscribe(TOPIC);
    a.publish(env("over real UDP"));
    const got: Envelope[] = [];
    const port = 40000 + Math.floor(Math.random() * 10000);
    let la, lb;
    try {
      la = await startLan(a, () => {}, { port, beaconMs: 100, interfaceAddress: "127.0.0.1" });
      lb = await startLan(b, (e) => got.push(e), { port, beaconMs: 100, interfaceAddress: "127.0.0.1" });
    } catch (e) {
      console.warn("multicast unavailable here; skipping", (e as Error).message);
      await la?.stop();
      return;
    }
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await la.stop();
    await lb.stop();
    expect(got.map((e) => e.message)).toEqual(["over real UDP"]);
  });
});
