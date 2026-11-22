import { describe, expect, it } from "vitest";
import {
  acceptPayload, AudioFrameReceiver, BleLink, deliverPayload, GossipNode, modulate, QrFrameReceiver, qrFrameSize,
  qrFrameTexts, resample, Resampler, encodeQr, qrCapacity, BLE_INBOX_UUID, BLE_OUTBOX_UUID, BLE_SERVICE_UUID,
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
    // 128 is the AudioWorklet render quantum; 441 and 4096 are typical native and ScriptProcessor buffers.
    for (const block of [128, 441, 4096]) {
      const got: Uint8Array[] = [];
      const rx = new AudioFrameReceiver({ sampleRate: 44_100, windowSeconds: 4, onPayload: (p) => got.push(p) });
      for (let o = 0; o < stream.length; o += block) rx.push(stream.subarray(o, o + block));
      expect(got, `${block}-sample blocks`).toEqual([payload]);
    }
  });

  it("hears a long frame from 16 kHz audio in AudioWorklet-sized blocks", () => {
    // ~7 s of tones: per-block resampling used to drift by more than a symbol over a frame this long.
    const payload = deliverPayload([{ id: "01JD5A2Z3K8Q9V6X7W4T1R0S2M", topic: TOPIC, message: "x".repeat(300), hops: 1 }]);
    for (const rate of [44_100, 16_000]) {
      const mic = resample(modulate(payload), 48_000, rate);
      const stream = new Float32Array(mic.length + rate);
      stream.set(mic, rate / 4);
      const got: Uint8Array[] = [];
      const rx = new AudioFrameReceiver({ sampleRate: rate, windowSeconds: 10, onPayload: (p) => got.push(p) });
      for (let o = 0; o < stream.length; o += 128) rx.push(stream.subarray(o, o + 128));
      expect(got, `${rate} Hz`).toEqual([payload]);
    }
  });
});

describe("streaming resampler", () => {
  it("matches resampling the whole stream at once, whatever the block sizes", () => {
    const x = Float32Array.from({ length: 10_000 }, (_, i) => Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.71));
    for (const [from, to] of [[44_100, 48_000], [16_000, 48_000], [96_000, 48_000], [48_000, 44_100]] as const) {
      const whole = resample(x, from, to);
      for (const block of [1, 7, 128, 1000]) {
        const r = new Resampler(from, to);
        const parts: number[] = [];
        for (let o = 0; o < x.length; o += block) parts.push(...r.push(x.subarray(o, o + block)));
        // The stream holds back the outputs past its last sample until the next block arrives.
        expect(whole.length - parts.length, `${from}→${to} in ${block}s`).toBeLessThanOrEqual(Math.ceil(to / from));
        expect(whole.length - parts.length).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < parts.length; i++) expect(parts[i]).toBeCloseTo(whole[i]!, 4);
      }
    }
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
    // Typically 1.1–1.5 × K frames, but the payload (random ids, the time) seeds the code, so
    // about 1 run in 80 needs 2 × K or more. 3 × K still shows it isn't waiting for repeats.
    expect(n).toBeLessThan(a.sourceBlocks * 3);
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
