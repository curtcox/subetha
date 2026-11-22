// Browser shims for edge transports: speakers/microphone (Web Audio), screen/camera
// (canvas + BarcodeDetector), and Web Bluetooth (central role). The protocol logic is in
// ./links.ts and runs anywhere.

import type { Envelope } from "../protocol/envelope.ts";
import { AUDIO_SAMPLE_RATE, modulate } from "./audio.ts";
import { BLE_INBOX_UUID, BLE_OUTBOX_UUID, BLE_SERVICE_UUID } from "./ble.ts";
import type { GossipNode } from "./gossip.ts";
import { AudioFrameReceiver, BleLink, QrFrameReceiver, qrFrameTexts } from "./links.ts";
import { drawQr, encodeQr, type QrEcl } from "./qrcode.ts";
import type { FountainProgress } from "./fountain.ts";

export interface Stoppable { stop(): void }

// ---- audio ----

/** Plays one modem frame through the speakers. Resolves when playback ends. */
export async function playAudioFrame(payload: Uint8Array, opts: { context?: AudioContext; volume?: number } = {}): Promise<void> {
  const ctx = opts.context ?? new AudioContext();
  const pcm = modulate(payload);
  const buf = ctx.createBuffer(1, pcm.length, AUDIO_SAMPLE_RATE);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = opts.volume ?? 1;
  src.connect(gain).connect(ctx.destination);
  await new Promise<void>((resolve) => {
    src.onended = () => resolve();
    src.start();
  });
  if (!opts.context) await ctx.close();
}

const WORKLET = `registerProcessor("subetha-tap", class extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
});`;

/** Listens on the microphone for modem frames until stopped. */
export async function listenAudio(
  onPayload: (payload: Uint8Array) => void,
  opts: { windowSeconds?: number; stream?: MediaStream } = {},
): Promise<Stoppable> {
  const stream = opts.stream ?? await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  const rx = new AudioFrameReceiver({ sampleRate: ctx.sampleRate, windowSeconds: opts.windowSeconds, onPayload });
  const source = ctx.createMediaStreamSource(stream);
  let node: AudioNode;
  if (ctx.audioWorklet) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const w = new AudioWorkletNode(ctx, "subetha-tap");
    w.port.onmessage = (e: MessageEvent<Float32Array>) => rx.push(e.data);
    node = w;
  } else {
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => rx.push(e.inputBuffer.getChannelData(0).slice());
    node = sp;
  }
  source.connect(node);
  // Some browsers only pull audio through nodes connected to the destination; keep it silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  return {
    stop() {
      source.disconnect();
      node.disconnect();
      if (!opts.stream) stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

// ---- animated QR ----

export interface AnimatedQrOptions {
  /** QR version (symbol size); bigger is faster but harder to scan. Default 12 (65×65). */
  version?: number;
  ecl?: QrEcl;
  /** Frames per second. Default 6. */
  fps?: number;
  /** Pixels per module. Default: fit the canvas width. */
  scale?: number;
}

/** Shows `payload` as an endless animated QR stream on a canvas until stopped. */
export function showAnimatedQr(canvas: HTMLCanvasElement, payload: Uint8Array, opts: AnimatedQrOptions = {}): Stoppable & { sourceBlocks: number } {
  const version = opts.version ?? 12;
  const ecl = opts.ecl ?? "L";
  const frames = qrFrameTexts(payload, version, ecl);
  const modules = version * 4 + 17 + 8;
  const scale = opts.scale ?? Math.max(2, Math.floor((canvas.width || 400) / modules));
  canvas.width = canvas.height = modules * scale;
  const ctx = canvas.getContext("2d")!;
  let seq = 0;
  const draw = () => drawQr(ctx, encodeQr(frames.text(seq++), { ecl, minVersion: version, maxVersion: version }), scale);
  draw();
  const timer = setInterval(draw, 1000 / (opts.fps ?? 6));
  return { sourceBlocks: frames.sourceBlocks, stop: () => clearInterval(timer) };
}

/** Anything that finds QR codes in a video frame (BarcodeDetector, or a jsQR wrapper). */
export type QrDetector = (video: HTMLVideoElement) => Promise<string[]>;

interface BarcodeDetectorLike { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }

export function barcodeDetector(): QrDetector | null {
  const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
  if (!BD) return null;
  const d = new BD({ formats: ["qr_code"] });
  return async (video) => (await d.detect(video)).map((r) => r.rawValue);
}

/** The jsQR function's shape (https://github.com/cozmo/jsQR); the SDK doesn't bundle it. */
export type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;

/**
 * A QrDetector for browsers without BarcodeDetector (Firefox, Safari, Chrome on Windows and Linux),
 * from jsQR. Frames are scaled down to `maxSide` pixels first, which keeps it fast on phones.
 */
export function jsQrDetector(jsQR: JsQr, opts: { maxSide?: number } = {}): QrDetector {
  let ctx: CanvasRenderingContext2D | null = null;
  return async (video) => {
    if (!video.videoWidth || !video.videoHeight) return [];
    const k = Math.min(1, (opts.maxSide ?? 720) / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
    ctx ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    ctx.canvas.width = w;
    ctx.canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
    return found ? [found.data] : [];
  };
}

/** Scans animated QR frames with the camera until a payload is complete or stopped. */
export async function scanAnimatedQr(
  video: HTMLVideoElement,
  onPayload: (payload: Uint8Array) => void,
  opts: { detect?: QrDetector; onProgress?: (p: FountainProgress) => void; stream?: MediaStream } = {},
): Promise<Stoppable> {
  const detect = opts.detect ?? barcodeDetector();
  if (!detect) throw new Error("no QR detector: this browser lacks BarcodeDetector; pass opts.detect (e.g. jsQrDetector(jsQR))");
  const stream = opts.stream ?? await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream;
  video.playsInline = true;
  await video.play();
  const rx = new QrFrameReceiver(onPayload);
  let running = true;
  const loop = async () => {
    while (running) {
      if (video.readyState >= 2) {
        try {
          for (const text of await detect(video)) {
            const p = rx.push(text);
            if (p) opts.onProgress?.(p);
          }
        } catch {
          // transient detector errors (e.g. frame not ready)
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  void loop();
  return {
    stop() {
      running = false;
      if (!opts.stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

// ---- Web Bluetooth (central) ----

interface GattCharacteristic extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<unknown>;
  writeValueWithResponse(v: BufferSource): Promise<void>;
}
interface GattServer {
  connected: boolean;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<GattCharacteristic> }>;
}
interface BleDevice extends EventTarget { name?: string; gatt?: { connect(): Promise<GattServer> } }
export interface BluetoothLike { requestDevice(o: { filters: { services: string[] }[] }): Promise<BleDevice> }

/**
 * Connects to a nearby SubEtha peer (a phone or gateway advertising the service) and runs
 * gossip with it. Browsers can only be the central, so the peer must be a native app.
 * Must be called from a user gesture.
 */
export async function connectBlePeer(
  node: GossipNode,
  onMessage: (env: Envelope) => void,
  opts: { attMtu?: number; bluetooth?: BluetoothLike } = {},
): Promise<{ name: string | undefined; resync(): Promise<void>; disconnect(): void }> {
  const bt = opts.bluetooth ?? (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth;
  if (!bt) throw new Error("Web Bluetooth is not available in this browser");
  const device = await bt.requestDevice({ filters: [{ services: [BLE_SERVICE_UUID] }] });
  const server = await device.gatt!.connect();
  const service = await server.getPrimaryService(BLE_SERVICE_UUID);
  const inbox = await service.getCharacteristic(BLE_INBOX_UUID);
  const outbox = await service.getCharacteristic(BLE_OUTBOX_UUID);
  // writeValueWithResponse uses long writes, so chunks may exceed the negotiated MTU.
  const link = new BleLink(node, (c) => inbox.writeValueWithResponse(c as Uint8Array<ArrayBuffer>), onMessage, opts.attMtu ?? 185);
  outbox.addEventListener("characteristicvaluechanged", () => {
    const v = outbox.value;
    if (v) void link.receive(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  });
  await outbox.startNotifications();
  await link.resync();
  return { name: device.name, resync: () => link.resync(), disconnect: () => server.disconnect() };
}
