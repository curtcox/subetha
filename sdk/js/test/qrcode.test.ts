import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { base45Encode, encodeQr, qrCapacity, type QrCode, type QrEcl } from "../src/edge/index.ts";

/** Renders to RGBA with a 4-module quiet zone and decodes with jsQR (an independent decoder). */
function decode(qr: QrCode, scale = 3): { data: string; bytes: number[] } | null {
  const margin = 4;
  const w = (qr.size + margin * 2) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y + margin) * scale + dy) * w + (x + margin) * scale + dx) * 4;
          px[o] = px[o + 1] = px[o + 2] = 0;
        }
      }
    }
  }
  const r = jsQR(px, w, w, { inversionAttempts: "dontInvert" });
  return r ? { data: r.data, bytes: r.binaryData } : null;
}

describe("QR encoder", () => {
  it("has the standard capacities", () => {
    expect(qrCapacity(1, "L", "byte")).toBe(17);
    expect(qrCapacity(1, "M", "byte")).toBe(14);
    expect(qrCapacity(1, "H", "byte")).toBe(7);
    expect(qrCapacity(10, "L", "byte")).toBe(271);
    expect(qrCapacity(10, "M", "byte")).toBe(213);
    expect(qrCapacity(10, "H", "byte")).toBe(119);
    expect(qrCapacity(40, "L", "byte")).toBe(2953);
    expect(qrCapacity(40, "H", "byte")).toBe(1273);
    expect(qrCapacity(1, "L", "alphanumeric")).toBe(25);
    expect(qrCapacity(1, "M", "alphanumeric")).toBe(20);
    expect(qrCapacity(40, "L", "alphanumeric")).toBe(4296);
  });

  it("picks the smallest version and alphanumeric mode for base45", () => {
    expect(encodeQr("HELLO WORLD", { ecl: "Q" }).version).toBe(1);
    expect(encodeQr("hello world", { ecl: "Q" }).version).toBe(1);
    expect(encodeQr("A".repeat(26), { ecl: "L" }).version).toBe(2);
    expect(() => encodeQr("x".repeat(3000), { ecl: "L" })).toThrow(/too long/);
  });

  it("decodes with an independent decoder across versions, levels and masks", () => {
    const cases: [string, QrEcl][] = [
      ["https://subetha.org/@alice/doorbell", "M"],
      ["HELLO WORLD", "H"],
      ["x".repeat(120), "L"], // v5
      ["y".repeat(150), "Q"], // v7+: version info
      [base45Encode(Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff)), "M"],
      ["héllo 🚪 " + "z".repeat(500), "L"],
    ];
    for (const [text, ecl] of cases) {
      const qr = encodeQr(text, { ecl });
      expect(decode(qr)?.data, `${ecl} v${qr.version}`).toBe(text);
    }
    for (let mask = 0; mask < 8; mask++) {
      const qr = encodeQr("MASK TEST 0123456789", { ecl: "M", mask, minVersion: 3 });
      expect(qr.mask).toBe(mask);
      expect(decode(qr)?.data, `mask ${mask}`).toBe("MASK TEST 0123456789");
    }
  });

  it("encodes raw bytes in byte mode", () => {
    const bytes = Uint8Array.from({ length: 200 }, (_, i) => (i * 13 + 7) & 0xff);
    const qr = encodeQr(bytes, { ecl: "L" });
    expect(decode(qr)?.bytes).toEqual([...bytes]);
  });

  it("handles large versions", () => {
    for (const v of [20, 32]) {
      const text = "Q".repeat(qrCapacity(v, "L", "alphanumeric"));
      const qr = encodeQr(text, { ecl: "L" });
      expect(qr.version).toBe(v);
      expect(decode(qr, 2)?.data, `v${v}`).toBe(text);
    }
  });
});
