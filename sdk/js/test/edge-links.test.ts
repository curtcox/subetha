import { describe, expect, it } from "vitest";
import {
  acceptPayload, AudioFrameReceiver, BleLink, deliverPayload, GossipNode, modulate, QrFrameReceiver, qrFrameSize,
  qrFrameTexts, resample, encodeQr, qrCapacity, BLE_INBOX_UUID, BLE_OUTBOX_UUID, BLE_SERVICE_UUID,
} from "../src/edge/index.ts";
import { connectBlePeer, type BluetoothLike } from "../src/edge/web.ts";
import { deviceKeyFromSeed, signEnvelope, ulid, type Envelope } from "../src/protocol/index.ts";

const TOPIC = "@alice/doorbell";
const nowS = () => Math.floor(Date.now() / 1000);
const env = (message: string, hops = 1): Envelope => ({ id: ulid(), time: nowS(), expires: nowS() + 600, topic: TOPIC, message, hops });
const subscribed = () => {
  const n = new GossipNode();
  n.subscribe(TOPIC);
  return n;
};

describe("one-way payloads", () => {
  it("deliver a signed envelope once", async () => {
    const key = await deviceKeyFromSeed(new Uint8Array(32).fill(3));
    const signed = await signEnvelope(env("ding"), key);
    const node = subscribed();
    const payload = deliverPayload([signed]);
    expect((await acceptPayload(node, payload)).map((e) => e.message)).toEqual(["ding"]);
    expect(await acceptPayload(node, payload)).toEqual([]); // dedupe
    expect(await acceptPayload(node, new TextEncoder().encode("garbage"))).toEqual([]);
  });
});

describe("audio receiver", () => {
  it("finds a frame in a 44.1 kHz microphone stream delivered in blocks", () => {
    const payload = deliverPayload([{ id: "01JD5A2Z3K8Q9V6X7W4T1R0S2M", topic: TOPIC, message: "hi", hops: 1 }]);
    const mic = resample(modulate(payload), 48_000, 44_100);
    const stream = new Float32Array(mic.length + 44_100);
    stream.set(mic, 20_000);
    for (let i = 0; i < stream.length; i++) stream[i]! += (Math.sin(i * 0.37) * 0.05); // hum
    const got: Uint8Array[] = [];
    const rx = new AudioFrameReceiver({ sampleRate: 44_100, windowSeconds: 4, onPayload: (p) => got.push(p) });
    for (let o = 0; o < stream.length; o += 4096) rx.push(stream.subarray(o, o + 4096));
    expect(got).toEqual([payload]);
  });
});

describe("animated QR", () => {
  it("frame size fills the symbol", () => {
    for (const v of [5, 12, 20]) {
      const size = qrFrameSize(v, "L");
      const texts = qrFrameTexts(new Uint8Array(5000), v, "L");
      const t = texts.text(0);
      expect(t.length).toBeLessThanOrEqual(qrCapacity(v, "L", "alphanumeric"));
      expect(encodeQr(t, { ecl: "L" }).version).toBe(v);
      expect(texts.sourceBlocks).toBe(Math.ceil(5000 / (size - 15)));
    }
  });
  it("reassembles from a lossy, late-joined scan and switches transfers", async () => {
    const first = deliverPayload(Array.from({ length: 12 }, (_, i) => env(`message ${i} `.repeat(10))));
    const second = deliverPayload([env("second transfer")]);
    const got: Uint8Array[] = [];
    const rx = new QrFrameReceiver((p) => got.push(p));
    const a = qrFrameTexts(first, 8, "M");
    let n = 0;
    for (let seq = 5; got.length === 0 && seq < 500; seq++) {
      if (seq % 3 === 0) continue; // dropped frames
      rx.push(a.text(seq));
      rx.push(a.text(seq)); // camera sees the same frame twice
      n++;
    }
    expect(got[0]).toEqual(first);
    expect(n).toBeLessThan(a.sourceBlocks * 2);
    expect(rx.push("not base45 at all")).toBeNull();
    const b = qrFrameTexts(second, 8, "M");
    for (let seq = 0; seq < b.sourceBlocks; seq++) rx.push(b.text(seq));
    expect(got[1]).toEqual(second);
    expect((await acceptPayload(subscribed(), got[1]!))[0]!.message).toBe("second transfer");
  });
});

describe("BLE", () => {
  it("two links gossip over 23-byte MTU chunks, both ways", async () => {
    const a = subscribed();
    const b = subscribed();
    const gotA: Envelope[] = [];
    const gotB: Envelope[] = [];
    let la: BleLink;
    const lb = new BleLink(b, (c) => la.receive(c), (e) => gotB.push(e));
    la = new BleLink(a, (c) => lb.receive(c), (e) => gotA.push(e));
    a.publish(env("from a, long enough to need many chunks at the default MTU"));
    b.publish(env("from b"));
    await la.resync();
    await lb.resync();
    expect(gotB.map((e) => e.message)).toEqual(["from a, long enough to need many chunks at the default MTU"]);
    expect(gotA.map((e) => e.message)).toEqual(["from b"]);
  });

  it("Web Bluetooth central talks to a peripheral", async () => {
    // Fake peripheral: a native app with its own node, reached through GATT.
    const phone = subscribed();
    phone.publish(env("hello from the phone"));
    const phoneGot: Envelope[] = [];
    const outbox = new EventTarget() as EventTarget & { value?: DataView; startNotifications(): Promise<void>; writeValueWithResponse(v: BufferSource): Promise<void> };
    outbox.startNotifications = async () => {};
    const notify = async (c: Uint8Array) => {
      outbox.value = new DataView(c.buffer, c.byteOffset, c.byteLength);
      outbox.dispatchEvent(new Event("characteristicvaluechanged"));
      await new Promise((r) => setTimeout(r, 0));
    };
    const phoneLink = new BleLink(phone, notify, (e) => phoneGot.push(e), 185);
    const inbox = { writeValueWithResponse: (v: BufferSource) => phoneLink.receive(new Uint8Array(v as ArrayBuffer | Uint8Array as Uint8Array)) };
    const requested: string[][] = [];
    const bluetooth: BluetoothLike = {
      async requestDevice(o) {
        requested.push(o.filters[0]!.services);
        return Object.assign(new EventTarget(), {
          name: "Phone",
          gatt: {
            async connect() {
              return {
                connected: true,
                disconnect() {},
                async getPrimaryService(uuid: string) {
                  expect(uuid).toBe(BLE_SERVICE_UUID);
                  return {
                    async getCharacteristic(c: string) {
                      if (c === BLE_INBOX_UUID) return inbox as never;
                      if (c === BLE_OUTBOX_UUID) return outbox as never;
                      throw new Error(c);
                    },
                  };
                },
              };
            },
          },
        });
      },
    };
    const browser = subscribed();
    const browserGot: Envelope[] = [];
    browser.publish(env("hello from the browser"));
    const peer = await connectBlePeer(browser, (e) => browserGot.push(e), { bluetooth });
    await new Promise((r) => setTimeout(r, 20));
    expect(requested).toEqual([[BLE_SERVICE_UUID]]);
    expect(peer.name).toBe("Phone");
    expect(phoneGot.map((e) => e.message)).toEqual(["hello from the browser"]);
    expect(browserGot.map((e) => e.message)).toEqual(["hello from the phone"]);
  });
});
