// The Edge lab's animated-QR transport (PLAN §6, Track F) in a real browser, both ways:
//  - display: the lab's canvas is captured frame by frame and decoded here with jsQR, an
//    independent decoder, until the fountain code completes and the signed envelope verifies;
//  - scan: an animated QR rendered by the SDK into a Y4M video is played into Chromium as its
//    camera. Headless Chromium on Linux has no BarcodeDetector, so this covers the lab's jsQR
//    fallback (tools/jsqr.js).
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import { generateDeviceKey, signEnvelope, ulid, type Envelope } from "@subetha/sdk";
import { acceptPayload, deliverPayload, encodeQr, GossipNode, QrFrameReceiver, qrFrameTexts } from "@subetha/sdk/edge";

const TOPIC = "@demo/edge"; // the Edge lab's default topic
const MESSAGE = `Gate unlocked ${Math.random().toString(36).slice(2, 8)} `.repeat(12).trim(); // > 1 QR frame

/** One QR symbol as a Y4M frame (I420, full range): `px` pixels square, 4-module quiet zone. */
function y4mFrame(modules: Uint8Array, size: number, px: number): Buffer {
  const scale = Math.floor(px / (size + 8));
  const off = Math.floor((px - size * scale) / 2);
  const y = Buffer.alloc(px * px, 255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r * size + c]) continue;
      for (let dy = 0; dy < scale; dy++) y.fill(0, (off + r * scale + dy) * px + off + c * scale, (off + r * scale + dy) * px + off + (c + 1) * scale);
    }
  }
  return Buffer.concat([Buffer.from("FRAME\n"), y, Buffer.alloc((px * px) / 2, 128)]);
}

const key = await generateDeviceKey();
const now = Math.floor(Date.now() / 1000);
const env = await signEnvelope({ id: ulid(), time: now, expires: now + 3600, topic: TOPIC, message: MESSAGE, hops: 1 } as Envelope, key);
const frames = qrFrameTexts(deliverPayload([env]), 10, "L");
const PX = 480;
const video: Buffer[] = [Buffer.from(`YUV4MPEG2 W${PX} H${PX} F4:1 Ip A1:1 C420jpeg\n`)];
for (let seq = 0; seq < 24; seq++) {
  const qr = encodeQr(frames.text(seq), { ecl: "L", minVersion: 10, maxVersion: 10 });
  const f = y4mFrame(qr.modules, qr.size, PX);
  video.push(f, f); // each symbol for half a second, as a phone camera would see a 2 fps display
}
const file = join(tmpdir(), `subetha-e2e-qr-${process.pid}.y4m`);
writeFileSync(file, Buffer.concat(video));

test.use({
  permissions: ["camera"],
  launchOptions: {
    ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}),
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${file}`],
  },
});

test("the Edge lab scans an animated QR from the camera (jsQR fallback)", async ({ page }) => {
  expect(frames.sourceBlocks).toBeGreaterThan(1);
  await page.goto("/tools/edge.html");
  await expect(page.locator("#who")).toContainText("This tab signs as dev_");
  expect(await page.evaluate(() => "BarcodeDetector" in globalThis)).toBe(false);
  const jsqr = page.waitForResponse((r) => r.url().endsWith("/tools/jsqr.js") && r.ok());
  await page.locator("#scan").click();
  await jsqr;
  await expect(page.locator("#cam")).toBeVisible();
  const item = page.locator("#inbox li", { hasText: "Gate unlocked" });
  await expect(item).toContainText(`QR · ${TOPIC} · ${MESSAGE} (from ${key.deviceId.slice(0, 12)}…, hops left 1)`, { timeout: 45_000 });
  await expect(page.locator("#qr-status")).toHaveText("Received.");
});

test("the Edge lab displays an animated QR that an independent decoder reads", async ({ page }) => {
  const message = `Porch light on ${Math.random().toString(36).slice(2, 8)} `.repeat(12).trim();
  await page.goto("/tools/edge.html");
  await expect(page.locator("#who")).toContainText("This tab signs as dev_");
  await page.locator("#msg").fill(message);
  await page.locator("#hops").fill("3");
  await page.locator("#show").click();
  await expect(page.locator("#qr")).toBeVisible();
  await expect(page.locator("#qr-status")).toContainText("source block(s)");

  const node = new GossipNode();
  node.subscribe(TOPIC);
  let payload: Uint8Array | null = null;
  const rx = new QrFrameReceiver((p) => { payload = p; });
  const seen = new Set<string>();
  for (let i = 0; i < 120 && !payload; i++) {
    const img = await page.evaluate(() => {
      const c = document.getElementById("qr") as HTMLCanvasElement;
      return { w: c.width, h: c.height, px: Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data) };
    });
    const found = jsQR(Uint8ClampedArray.from(img.px), img.w, img.h, { inversionAttempts: "dontInvert" });
    if (found && !seen.has(found.data)) {
      seen.add(found.data);
      rx.push(found.data);
    }
    await page.waitForTimeout(80);
  }
  expect(seen.size).toBeGreaterThan(1);
  expect(payload).not.toBeNull();
  const [got] = await acceptPayload(node, payload!); // verifies the tab's signature
  expect(got?.message).toBe(message);
  expect(got?.topic).toBe(TOPIC);
  expect(got?.hops).toBe(3);
  expect(got?.sender).toMatch(/^dev_/);
});
