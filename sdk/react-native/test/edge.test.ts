import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { deviceKeyFromSeed, signEnvelope, ulid, type Envelope } from "@subetha/sdk";
import * as edge from "../src/edge.ts";
import {
  animateQr, audioFrameWav, base64Decode, base64Encode, BLE_INBOX_UUID, BLE_OUTBOX_UUID, BLE_SERVICE_UUID, BleLink,
  connectBlePlxPeer, createEdgeNode, deliverPayload, edgeVerifier, GossipNode, listenPcm16, pcm16ToFloat32, qrFrames,
  QrFrameReceiver, qrSvgPath, startLanWith, wavFile, type DgramLike, type DgramSocketLike, type Pcm16Stream, type PlxDevice,
  type PlxManager, type QrCode,
} from "../src/edge.ts";
import type { SubEthaCore } from "../src/core.ts";

const TOPIC = "@alice/doorbell";
const nowS = () => Math.floor(Date.now() / 1000);
const env = (message: string, hops = 1): Envelope => ({ id: ulid(), time: nowS(), expires: nowS() + 600, topic: TOPIC, message, hops });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("base64", () => {
  it("matches Buffer for every length and accepts URL-safe input", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const s = Buffer.from(b).toString("base64");
      expect(base64Encode(b)).toBe(s);
      expect([...base64Decode(s)]).toEqual([...b]);
      expect([...base64Decode(Buffer.from(b).toString("base64url"))]).toEqual([...b]);
    }
    expect(() => base64Decode("ab$c")).toThrow();
  });
});

describe("gossip nodes on Hermes", () => {
  it("verify with the core, with WebCrypto, or drop signed messages", async () => {
    const key = await deviceKeyFromSeed(new Uint8Array(32).fill(7));
    const signed = await signEnvelope(env("signed"), key);
    const calls: string[] = [];
    const core = { verifyEnvelopeJson: (j: string) => (calls.push(j), true) } as unknown as SubEthaCore;

    const withCore = createEdgeNode({ core });
    withCore.subscribe(TOPIC);
    expect((await withCore.handle({ type: "deliver", envelopes: [signed] })).delivered).toHaveLength(1);
    expect(JSON.parse(calls[0]!).sig).toBe(signed.sig);

    // Node has WebCrypto Ed25519, standing in for a polyfill.
    const viaWebCrypto = edgeVerifier(null, true)!;
    expect(await viaWebCrypto(signed)).toBe(true);
    expect(await viaWebCrypto({ ...signed, message: "forged" })).toBe(false);
    expect(edgeVerifier(null, false)).toBeNull();

    // No core and no WebCrypto (Hermes): signed messages are dropped, unsigned ones pass.
    const subtle = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    let none: GossipNode;
    try {
      none = createEdgeNode();
    } finally {
      Object.defineProperty(globalThis, "crypto", subtle);
    }
    none.subscribe(TOPIC);
    const h = await none.handle({ type: "deliver", envelopes: [signed, env("plain")] });
    expect(h.delivered.map((e) => e.message)).toEqual(["plain"]);
    expect(h.dropped[0]!.reason).toBe("bad_signature");
  });
});

describe("sound", () => {
  it("writes a playable WAV and decodes PCM16 microphone chunks", async () => {
    const node = createEdgeNode();
    node.subscribe(TOPIC);
    const payload = deliverPayload([env("by sound")]);
    const wav = audioFrameWav(payload, { volume: 0.8 });
    const text = (a: number, n: number) => String.fromCharCode(...wav.subarray(a, a + n));
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(40, true)).toBe(wav.length - 44);
    expect(pcm16ToFloat32(wav.subarray(44)).reduce((m, x) => Math.max(m, Math.abs(x)), 0)).toBeLessThanOrEqual(0.8 * 0.5 + 1e-3);

    // A fake react-native-live-audio-stream: silence, the frame, silence, in 4096-byte chunks.
    let listener: ((b64: string) => void) | null = null;
    const inits: unknown[] = [];
    const stream: Pcm16Stream = {
      init: (o) => inits.push(o),
      on: (_e, l) => (listener = l),
      start() {},
      stop() {},
    };
    const got: Uint8Array[] = [];
    const rx = listenPcm16(stream, (p) => got.push(p), { sampleRate: 48_000 });
    const pcm = new Uint8Array(48_000 + (wav.length - 44) + 96_000);
    pcm.set(wav.subarray(44), 48_000);
    for (let i = 0; i < pcm.length; i += 4096) listener!(base64Encode(pcm.subarray(i, i + 4096)));
    rx.stop();
    expect(inits[0]).toMatchObject({ sampleRate: 48_000, channels: 1, bitsPerSample: 16, audioSource: 6 });
    expect(got).toHaveLength(1);
    const delivered = await edge.acceptPayload(node, got[0]!);
    expect(delivered.map((e) => e.message)).toEqual(["by sound"]);

    // A second listen on the same stream reuses its one listener; the stopped one is silent.
    const again: Uint8Array[] = [];
    const rx2 = listenPcm16(stream, (p) => again.push(p), { sampleRate: 48_000 });
    for (let i = 0; i < pcm.length; i += 4096) listener!(base64Encode(pcm.subarray(i, i + 4096)));
    rx2.stop();
    expect(got).toHaveLength(1);
    expect(again).toHaveLength(1);
    expect(wavFile(new Float32Array(0)).length).toBe(44);
  });
});

/** Draws an SVG path from qrSvgPath back onto a grid (it only emits `Mx yhNv1h-Nz`). */
function rasterize(path: { size: number; d: string }, scale = 3): Uint8ClampedArray {
  const w = path.size * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (const m of path.d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < run * scale; dx++) {
        const i = ((y * scale + dy) * w + x * scale + dx) * 4;
        px[i] = px[i + 1] = px[i + 2] = 0;
      }
    }
  }
  return px;
}

describe("animated QR", () => {
  it("renders frames as SVG paths that a camera-side decoder reads back", async () => {
    const node = createEdgeNode();
    node.subscribe(TOPIC);
    const payload = deliverPayload([env("by QR " + "x".repeat(1500))]);
    const frames = qrFrames(payload, { version: 10 });
    expect(frames.sourceBlocks).toBeGreaterThan(1);

    const q: QrCode = frames.frame(0);
    const path = qrSvgPath(q);
    expect(path.size).toBe(q.size + 8);
    const dark = [...path.d.matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(dark).toBe(q.modules.reduce((n, b) => n + b, 0));

    let done: Uint8Array | null = null;
    const rx = new QrFrameReceiver((p) => (done = p));
    for (let seq = 0; !done && seq < frames.sourceBlocks * 3; seq++) {
      const p = qrSvgPath(frames.frame(seq));
      const r = jsQR(rasterize(p), p.size * 3, p.size * 3, { inversionAttempts: "dontInvert" });
      expect(r, `frame ${seq}`).not.toBeNull();
      rx.push(r!.data);
    }
    expect(done).not.toBeNull();
    expect((await edge.acceptPayload(node, done!)).map((e) => e.message!.slice(0, 5))).toEqual(["by QR"]);

    const seen: number[] = [];
    const anim = animateQr(payload, (f) => seen.push(f.seq), { fps: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    anim.stop();
    expect(seen.slice(0, 3)).toEqual([0, 1, 2]);
  });
});

describe("BLE central over react-native-ble-plx", () => {
  it("connects to a native peripheral and gossips both ways", async () => {
    // The peripheral: a native sample's GATT server, modelled with the SDK's BleLink.
    const periph = new GossipNode();
    periph.subscribe(TOPIC);
    periph.publish(env("from the phone"));
    const periphGot: Envelope[] = [];
    let notify: ((error: Error | null, c: { value: string | null } | null) => void) | null = null;
    const writes: number[] = [];
    let inFlight = 0;
    const periphLink = new BleLink(periph, (c) => notify?.(null, { value: base64Encode(c) }), (e) => periphGot.push(e), 185);

    let disconnected: ((error: Error | null, d: PlxDevice) => void) | null = null;
    const device: PlxDevice = {
      id: "AA:BB", name: "Pixel", mtu: 185,
      discoverAllServicesAndCharacteristics: async () => device,
      monitorCharacteristicForService: (s, c, l) => {
        expect([s, c]).toEqual([BLE_SERVICE_UUID, BLE_OUTBOX_UUID]);
        notify = l;
        setTimeout(() => void periphLink.resync(), 0); // the native peripheral resyncs when the central subscribes
        return { remove: () => (notify = null) };
      },
      async writeCharacteristicWithResponseForService(s, c, v) {
        expect([s, c]).toEqual([BLE_SERVICE_UUID, BLE_INBOX_UUID]);
        expect(++inFlight).toBe(1); // writes are serialized
        const bytes = base64Decode(v);
        writes.push(bytes.length);
        await tick();
        inFlight--;
        await periphLink.receive(bytes);
      },
      cancelConnection: async () => disconnected?.(null, device),
      onDisconnected: (l) => ((disconnected = l), { remove: () => (disconnected = null) }),
    };
    const scans: unknown[] = [];
    const manager: PlxManager = {
      startDeviceScan: (uuids, _o, l) => {
        scans.push(uuids);
        setTimeout(() => l(null, device), 5);
      },
      stopDeviceScan: () => scans.push("stop"),
      connectToDevice: async (id, o) => {
        expect(id).toBe("AA:BB");
        expect(o?.requestMTU).toBe(517);
        return device;
      },
    };

    const central = createEdgeNode();
    central.subscribe(TOPIC);
    const got: Envelope[] = [];
    let lost = false;
    const peer = await connectBlePlxPeer(manager, central, (e) => got.push(e), { onDisconnect: () => (lost = true) });
    expect(scans).toEqual([[BLE_SERVICE_UUID], "stop"]);
    expect(peer.mtu).toBe(185);
    for (let i = 0; i < 20 && !got.length; i++) await tick();
    expect(got.map((e) => e.message)).toEqual(["from the phone"]);

    central.publish(env("from RN " + "y".repeat(600)));
    await peer.resync();
    for (let i = 0; i < 50 && !periphGot.length; i++) await tick();
    expect(periphGot.map((e) => e.message!.slice(0, 7))).toEqual(["from RN"]);
    expect(Math.max(...writes)).toBeLessThanOrEqual(185 - 3);

    await peer.disconnect();
    expect(notify).toBeNull();
    expect(lost).toBe(false); // listeners removed before cancelling
  });

  it("gives up when no peer is advertising", async () => {
    const manager: PlxManager = { startDeviceScan() {}, stopDeviceScan() {}, connectToDevice: async () => { throw new Error("unused"); } };
    await expect(connectBlePlxPeer(manager, new GossipNode(), () => {}, { timeoutMs: 20 })).rejects.toThrow(/no SubEtha peer/);
  });
});

/** An in-memory UDP network shaped like react-native-udp: unicast by port, multicast by group. */
function fakeUdp(host: string, net: { sockets: Map<string, FakeSocket> }): DgramLike {
  return { createSocket: () => new FakeSocket(host, net) };
}
let nextPort = 40_000;
class FakeSocket implements DgramSocketLike {
  port = 0;
  groups = new Set<string>();
  private onMsg: ((m: Uint8Array, r: { address: string; port: number }) => void) | null = null;
  readonly host: string;
  readonly net: { sockets: Map<string, FakeSocket> };
  constructor(host: string, net: { sockets: Map<string, FakeSocket> }) {
    this.host = host;
    this.net = net;
  }
  bind(port: number, cb: () => void) {
    this.port = port || nextPort++;
    this.net.sockets.set(`${this.host}:${this.port}:${Math.random()}`, this);
    setTimeout(cb, 0);
  }
  address() { return { port: this.port }; }
  send(msg: Uint8Array, offset: number, length: number, port: number, address: string, cb?: () => void) {
    expect(offset).toBe(0); // react-native-udp rejects other offsets
    expect(length).toBe(msg.length);
    const copy = Buffer.from(msg);
    for (const s of this.net.sockets.values()) {
      const hit = address.startsWith("239.") ? s.groups.has(address) && s.port === port : s.host === address && s.port === port;
      if (hit) setTimeout(() => s.onMsg?.(copy, { address: this.host, port: this.port }), 0);
    }
    cb?.();
  }
  on(_e: "message", l: (m: Uint8Array, r: { address: string; port: number }) => void) { this.onMsg = l; }
  once() {}
  addMembership(g: string) { this.groups.add(g); }
  close(cb?: () => void) {
    for (const [k, s] of this.net.sockets) if (s === this) this.net.sockets.delete(k);
    cb?.();
  }
}

describe("LAN over a react-native-udp-shaped module", () => {
  it("finds a peer by beacon and gossips", async () => {
    const net = { sockets: new Map<string, FakeSocket>() };
    const a = createEdgeNode();
    const b = createEdgeNode();
    a.subscribe(TOPIC);
    b.subscribe(TOPIC);
    a.publish(env("over wifi", 2));
    const got: Envelope[] = [];
    const la = await startLanWith(fakeUdp("192.168.1.10", net), a, () => {}, { beaconMs: 20, nodeId: "00000000000000aa" });
    const lb = await startLanWith(fakeUdp("192.168.1.11", net), b, (e) => got.push(e), { beaconMs: 20 });
    for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(got.map((e) => e.message)).toEqual(["over wifi"]);
    expect(la.nodeId).toBe("00000000000000aa");
    expect(lb.nodeId).toMatch(/^[0-9a-f]{16}$/);
    expect(la.peers()).toBe(1);
    await Promise.all([la.stop(), lb.stop()]);
    expect(net.sockets.size).toBe(0);
  });
});
