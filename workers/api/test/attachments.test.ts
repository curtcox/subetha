import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { auth, balance, BASE, bootstrap } from "./helpers.ts";

describe("attachments", () => {
  it("uploads with X-Filename, charges for storage, serves the file, and rejects oversize uploads", async () => {
    const a = await bootstrap("filer", 1);
    const small = await SELF.fetch(`${BASE}/@filer/x`, { method: "PUT", body: "hi", headers: auth(a.token) });
    const smallCost = Number(small.headers.get("x-cost-micros"));
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(7);
    const before = await balance(a.token);
    const r = await SELF.fetch(`${BASE}/@filer/x`, { method: "PUT", body: bytes, headers: auth(a.token, { "X-Filename": "snap.jpg", "content-type": "image/jpeg", "X-Title": "Snapshot" }) });
    expect(r.status).toBe(200);
    const msg = (await r.json()) as { message: string; attachment: { name: string; url: string; size: number; type: string } };
    expect(msg.message).toBe("You received a file: snap.jpg");
    expect(msg.attachment).toMatchObject({ name: "snap.jpg", size: bytes.length, type: "image/jpeg" });
    expect(Number(r.headers.get("x-cost-micros"))).toBeGreaterThan(smallCost);
    expect(await balance(a.token)).toBeLessThan(before);

    const path = new URL(msg.attachment.url).pathname;
    const dl = await SELF.fetch(`${BASE}${path}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/jpeg");
    expect((await dl.arrayBuffer()).byteLength).toBe(bytes.length);
    expect((await SELF.fetch(`${BASE}/file/nope/x`)).status).toBe(404);

    const big = await SELF.fetch(`${BASE}/@filer/x`, { method: "PUT", body: new Uint8Array(16 * 1024 * 1024), headers: auth(a.token, { "X-Filename": "big.bin" }) });
    expect(big.status).toBe(413);
  });

  it("deletes the stored file when the publish is refused", async () => {
    const a = await bootstrap("nofunds", 0);
    const r = await SELF.fetch(`${BASE}/@nofunds/x`, { method: "PUT", body: "file", headers: auth(a.token, { "X-Filename": "a.txt" }) });
    expect(r.status).toBe(402);
  });
});
