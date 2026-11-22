// The Edge lab's sound transport (PLAN §6, Track F) in a real browser: a signed envelope, modulated
// by the SDK's modem into a WAV file, is played into Chromium as its microphone. The page listens
// through getUserMedia and an AudioWorklet, demodulates, verifies, and shows the message. Nothing
// touches the relay.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { generateDeviceKey, signEnvelope, ulid, type Envelope } from "@subetha/sdk";
import { AUDIO_SAMPLE_RATE, deliverPayload, modulate } from "@subetha/sdk/edge";

const TOPIC = "@demo/edge"; // the Edge lab's default topic
const MESSAGE = `Back door opened ${Math.random().toString(36).slice(2, 8)}`;

/** 16-bit mono PCM WAV. */
function wav(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return b;
}

const key = await generateDeviceKey();
const now = Math.floor(Date.now() / 1000);
const env = await signEnvelope({ id: ulid(), time: now, expires: now + 3600, topic: TOPIC, message: MESSAGE, hops: 1 } as Envelope, key);
const frame = modulate(deliverPayload([env]));
// Chromium loops the file: half a second of silence on each side of the frame.
const pad = new Float32Array(AUDIO_SAMPLE_RATE / 2);
const audio = new Float32Array(pad.length * 2 + frame.length);
audio.set(frame, pad.length);
const file = join(tmpdir(), `subetha-e2e-audio-${process.pid}.wav`);
writeFileSync(file, wav(audio, AUDIO_SAMPLE_RATE));

test.use({
  permissions: ["microphone"],
  launchOptions: {
    ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}),
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${file}`, "--autoplay-policy=no-user-gesture-required"],
  },
});

test("the Edge lab hears a signed message over sound", async ({ page }) => {
  await page.goto("/tools/edge.html");
  await expect(page.locator("#who")).toContainText("This tab signs as dev_");
  await page.locator("#listen").click();
  await expect(page.locator("#audio-status")).toHaveText("Listening…");
  const item = page.locator("#inbox li", { hasText: MESSAGE });
  await expect(item).toContainText(`sound · ${TOPIC} · ${MESSAGE} (from ${key.deviceId.slice(0, 12)}…, hops left 1)`, { timeout: 30_000 });
  await expect(page.locator("#audio-status")).toHaveText("Received.");
});

test("the Edge lab plays a message without errors", async ({ page }) => {
  await page.goto("/tools/edge.html");
  await expect(page.locator("#who")).toContainText("This tab signs as dev_");
  await page.locator("#msg").fill("ping");
  await page.locator("#play").click();
  await expect(page.locator("#audio-status")).toHaveText("Sent.", { timeout: 30_000 });
});
