// Edge transports for React Native (PLAN §6, spec §11). The protocol logic is the TypeScript
// SDK's (`@subetha/sdk/edge`: gossip, BLE chunking, the audio modem, fountain-coded QR, LAN),
// which runs on Hermes as-is. This module adds what RN lacks and the glue to the usual RN
// libraries, typed structurally so this package has no native dependencies:
//
// - signatures: Hermes has no WebCrypto Ed25519, so gossip nodes verify with the Rust core
//   (`loadCore()`) when it's installed;
// - BLE: a central over react-native-ble-plx (base64 values, serialized writes);
// - sound: WAV bytes to play with any audio player, and PCM16 microphone chunks (e.g.
//   react-native-live-audio-stream) into the modem;
// - QR: SVG path data for each animated frame (react-native-svg), and scanned strings (e.g.
//   expo-camera's onBarcodeScanned) into QrFrameReceiver;
// - LAN: react-native-udp through `startLanWith`.

import { verifyEnvelope, type Envelope } from "@subetha/sdk";
import {
  AUDIO_SAMPLE_RATE, AudioFrameReceiver, BLE_INBOX_UUID, BLE_OUTBOX_UUID, BLE_SERVICE_UUID, BleLink, encodeQr, GossipNode,
  modulate, qrFrameTexts, type GossipConfig, type QrCode, type QrEcl,
} from "@subetha/sdk/edge";
import type { SubEthaCore } from "./core.ts";

export * from "@subetha/sdk/edge";

// ---- base64 (ble-plx and audio-stream values; Hermes' atob/btoa vary by RN version) ----

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? B64[n & 63]! : "=");
  }
  return out;
}

/** Standard or URL-safe base64, padded or not. Throws on other characters. */
export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const c of clean) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new Error("invalid base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// ---- gossip nodes that can check signatures on Hermes ----

export type EnvelopeVerifier = (env: Envelope) => boolean | Promise<boolean>;

const hasWebCryptoEd25519 = () =>
  typeof (globalThis as { crypto?: { subtle?: { verify?: unknown } } }).crypto?.subtle?.verify === "function";

/**
 * The signature check for this runtime: the Rust core if it's loaded, WebCrypto if present
 * (a polyfill, or a debug build running in a browser engine), else null.
 */
export function edgeVerifier(core: SubEthaCore | null | undefined, webCrypto = hasWebCryptoEd25519()): EnvelopeVerifier | null {
  if (core) return (env) => core.verifyEnvelopeJson(JSON.stringify(env));
  if (webCrypto) return (env) => verifyEnvelope(env as unknown as Record<string, unknown>);
  return null;
}

/**
 * A gossip node for this runtime. Without a verifier, signed messages are dropped
 * (`bad_signature`), never accepted unchecked; unsigned ones pass unless
 * `requireSignatures` is set.
 */
export function createEdgeNode(opts: { core?: SubEthaCore | null; config?: Partial<GossipConfig> } = {}): GossipNode {
  const verify = opts.config?.verify ?? edgeVerifier(opts.core) ?? (() => false);
  return new GossipNode({ ...opts.config, verify });
}

// ---- sound ----

/** Little-endian signed 16-bit PCM → floats in [-1, 1). */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Floats → little-endian signed 16-bit PCM (clipped). */
export function float32ToPcm16(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < x.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32768))), true);
  return out;
}

/** A mono 16-bit PCM WAV file. */
export function wavFile(pcm: Float32Array, sampleRate = AUDIO_SAMPLE_RATE): Uint8Array {
  const data = float32ToPcm16(pcm);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** The modem frame for `payload` as a WAV file, for any player (expo-av, expo-audio, …). */
export function audioFrameWav(payload: Uint8Array, opts: { volume?: number } = {}): Uint8Array {
  const pcm = modulate(payload);
  const vol = opts.volume ?? 1;
  if (vol !== 1) for (let i = 0; i < pcm.length; i++) pcm[i]! *= vol;
  return wavFile(pcm);
}

/** A microphone stream of base64 PCM16 chunks, shaped like react-native-live-audio-stream. */
export interface Pcm16Stream {
  init(opts: { sampleRate: number; channels: 1; bitsPerSample: 16; audioSource?: number; bufferSize?: number; wavFile?: string }): void;
  on(event: "data", listener: (base64: string) => void): unknown;
  start(): void;
  stop(): void;
}

// The stream libraries have no way to remove a listener, so each stream gets one, and it
// forwards to whichever listen call is current.
const streamSinks = new WeakMap<Pcm16Stream, { sink: ((b64: string) => void) | null }>();

/**
 * Listens for modem frames on a PCM16 microphone stream until stopped. Android's audioSource 6
 * (VOICE_RECOGNITION) skips most of the processing that smears tones; 9 (UNPROCESSED) is
 * better where the device supports it.
 */
export function listenPcm16(
  stream: Pcm16Stream,
  onPayload: (payload: Uint8Array) => void,
  opts: { sampleRate?: number; audioSource?: number; bufferSize?: number; windowSeconds?: number } = {},
): { stop(): void } {
  const sampleRate = opts.sampleRate ?? 44_100;
  const rx = new AudioFrameReceiver({ sampleRate, windowSeconds: opts.windowSeconds, onPayload });
  let slot = streamSinks.get(stream);
  if (!slot) {
    const s = { sink: null as ((b64: string) => void) | null };
    stream.on("data", (b64) => s.sink?.(b64));
    streamSinks.set(stream, (slot = s));
  }
  const sink = (b64: string) => {
    try {
      rx.push(pcm16ToFloat32(base64Decode(b64)));
    } catch {
      // a malformed chunk; keep listening
    }
  };
  slot.sink = sink;
  stream.init({ sampleRate, channels: 1, bitsPerSample: 16, audioSource: opts.audioSource ?? 6, bufferSize: opts.bufferSize ?? 4096, wavFile: "" });
  stream.start();
  return {
    stop() {
      if (slot.sink === sink) slot.sink = null;
      stream.stop();
    },
  };
}

// ---- animated QR ----

/** Each animated-QR frame of `payload` as a QR symbol (render with qrSvgPath). */
export function qrFrames(payload: Uint8Array, opts: { version?: number; ecl?: QrEcl } = {}): { sourceBlocks: number; frame(seq: number): QrCode } {
  const version = opts.version ?? 12;
  const ecl = opts.ecl ?? "L";
  const frames = qrFrameTexts(payload, version, ecl);
  return { sourceBlocks: frames.sourceBlocks, frame: (seq) => encodeQr(frames.text(seq), { ecl, minVersion: version, maxVersion: version }) };
}

/**
 * SVG path data for the dark modules, one rectangle per horizontal run, with a quiet zone of
 * `margin` modules. Draw it on a white square: `<Svg viewBox={`0 0 ${size} ${size}`}>`.
 */
export function qrSvgPath(qr: QrCode, margin = 4): { size: number; d: string } {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; ) {
      if (!qr.modules[y * qr.size + x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && qr.modules[y * qr.size + x + run]) run++;
      parts.push(`M${x + margin} ${y + margin}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return { size: qr.size + margin * 2, d: parts.join("") };
}

/** Calls `onFrame` with each frame's SVG path at `fps` until stopped (for React state). */
export function animateQr(
  payload: Uint8Array,
  onFrame: (frame: { size: number; d: string; seq: number }) => void,
  opts: { version?: number; ecl?: QrEcl; fps?: number } = {},
): { sourceBlocks: number; stop(): void } {
  const frames = qrFrames(payload, opts);
  let seq = 0;
  const tick = () => {
    const s = seq++;
    onFrame({ ...qrSvgPath(frames.frame(s)), seq: s });
  };
  tick();
  const timer = setInterval(tick, 1000 / (opts.fps ?? 6));
  return { sourceBlocks: frames.sourceBlocks, stop: () => clearInterval(timer) };
}

// ---- Bluetooth LE central (react-native-ble-plx) ----

/** The parts of react-native-ble-plx's Device this module uses. */
export interface PlxDevice {
  id: string;
  name: string | null;
  mtu: number;
  discoverAllServicesAndCharacteristics(): Promise<PlxDevice>;
  monitorCharacteristicForService(
    service: string,
    characteristic: string,
    listener: (error: Error | null, characteristic: { value: string | null } | null) => void,
  ): { remove(): void };
  writeCharacteristicWithResponseForService(service: string, characteristic: string, valueBase64: string): Promise<unknown>;
  cancelConnection(): Promise<unknown>;
  onDisconnected?(listener: (error: Error | null, device: PlxDevice) => void): { remove(): void };
}

/** The parts of react-native-ble-plx's BleManager this module uses. */
export interface PlxManager {
  startDeviceScan(uuids: string[] | null, options: object | null, listener: (error: Error | null, device: PlxDevice | null) => void): unknown;
  stopDeviceScan(): unknown;
  connectToDevice(id: string, options?: { requestMTU?: number; timeout?: number }): Promise<PlxDevice>;
}

/** Scans for the first peer advertising the SubEtha service. */
export function findBlePeer(manager: PlxManager, opts: { timeoutMs?: number } = {}): Promise<PlxDevice> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, dev?: PlxDevice) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void manager.stopDeviceScan();
      if (dev) resolve(dev);
      else reject(err ?? new Error("no SubEtha peer found"));
    };
    const timer = setTimeout(() => finish(new Error("no SubEtha peer found nearby")), opts.timeoutMs ?? 15_000);
    void manager.startDeviceScan([BLE_SERVICE_UUID], null, (error, device) => {
      if (error) finish(error);
      else if (device) finish(null, device);
    });
  });
}

export interface BlePeer {
  id: string;
  name: string | null;
  /** The ATT MTU gossip chunks are sized for. */
  mtu: number;
  /** Re-send our summary (after publishing). */
  resync(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Connects to a SubEtha peer (a native sample app or gateway acting as the GATT peripheral)
 * and gossips with it: notifications on the outbox, writes to the inbox. react-native-ble-plx
 * is central-only, so two RN apps can't connect to each other; each needs a native peer.
 */
export async function connectBlePlxPeer(
  manager: PlxManager,
  node: GossipNode,
  onMessage: (env: Envelope) => void,
  opts: { device?: PlxDevice; timeoutMs?: number; requestMtu?: number; onDisconnect?: (error: Error | null) => void } = {},
): Promise<BlePeer> {
  const found = opts.device ?? await findBlePeer(manager, { timeoutMs: opts.timeoutMs });
  // requestMTU applies on Android; iOS negotiates on its own and reports it in `mtu`.
  const device = await (await manager.connectToDevice(found.id, { requestMTU: opts.requestMtu ?? 517 })).discoverAllServicesAndCharacteristics();
  const mtu = Math.max(23, Math.min(517, device.mtu || 23));
  // One GATT operation at a time: Android drops writes issued while one is in flight.
  let queue: Promise<unknown> = Promise.resolve();
  const write = (c: Uint8Array) => {
    const next = queue.then(() => device.writeCharacteristicWithResponseForService(BLE_SERVICE_UUID, BLE_INBOX_UUID, base64Encode(c)));
    queue = next.catch(() => {});
    return next.then(() => {});
  };
  const link = new BleLink(node, write, onMessage, mtu);
  const monitor = device.monitorCharacteristicForService(BLE_SERVICE_UUID, BLE_OUTBOX_UUID, (error, ch) => {
    if (error || !ch?.value) return;
    try {
      void link.receive(base64Decode(ch.value));
    } catch {
      // not base64; ignore
    }
  });
  const disc = device.onDisconnected?.((error) => {
    monitor.remove();
    disc?.remove();
    opts.onDisconnect?.(error);
  });
  await link.resync();
  return {
    id: device.id,
    name: device.name,
    mtu,
    resync: () => link.resync(),
    async disconnect() {
      monitor.remove();
      disc?.remove();
      await device.cancelConnection().catch(() => {});
    },
  };
}
