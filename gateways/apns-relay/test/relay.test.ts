import { createServer as createH2, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay } from "../src/relay.ts";

const SECRET = "test-relay-secret-0123456789";
const TOKEN = "ab".repeat(32);
let apns: Http2Server;
let relay: ReturnType<typeof createRelay>;
let base = "";
const seen: { path: string; headers: Record<string, unknown>; body: string }[] = [];
let sessions = 0;

beforeAll(async () => {
  // A cleartext HTTP/2 server standing in for api.push.apple.com.
  apns = createH2();
  apns.on("session", () => sessions++);
  apns.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const path = String(headers[":path"]);
      seen.push({ path, headers, body: Buffer.concat(chunks).toString() });
      if (path.endsWith("dead".repeat(16))) {
        stream.respond({ ":status": 410, "apns-id": "id-410", "content-type": "application/json" });
        stream.end(JSON.stringify({ reason: "Unregistered", timestamp: 1 }));
      } else if (path.endsWith("5105".repeat(16))) {
        // never answers (timeout)
      } else {
        stream.respond({ ":status": 200, "apns-id": "11111111-2222-3333-4444-555555555555" });
        stream.end();
      }
    });
  });
  await new Promise<void>((r) => apns.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${(apns.address() as AddressInfo).port}`;
  relay = createRelay({ secret: SECRET, upstream, timeoutMs: 300, log: () => {} });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
});

afterAll(async () => {
  relay.closeAllConnections();
  await new Promise((r) => relay.close(r));
  await new Promise((r) => apns.close(r));
});

const push = (token: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(`${base}/3/device/${token}`, { method: "POST", body: JSON.stringify({ aps: { alert: "hi" } }), ...init, headers: { "x-relay-secret": SECRET, authorization: "bearer eyJ.provider.jwt", "apns-topic": "org.subetha.app", "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json", ...init.headers } });

describe("APNs relay", () => {
  it("forwards over HTTP/2 with headers and body unchanged, reusing one connection", async () => {
    const r = await push(TOKEN, { headers: { "apns-expiration": "1800000000", "x-other": "dropped" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("apns-id")).toBe("11111111-2222-3333-4444-555555555555");
    const s = seen.at(-1)!;
    expect(s.path).toBe(`/3/device/${TOKEN}`);
    expect(s.headers).toMatchObject({ authorization: "bearer eyJ.provider.jwt", "apns-topic": "org.subetha.app", "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": "1800000000" });
    expect(s.headers["x-other"]).toBeUndefined();
    expect(s.headers["x-relay-secret"]).toBeUndefined();
    expect(JSON.parse(s.body)).toEqual({ aps: { alert: "hi" } });
    await push(TOKEN);
    expect(sessions).toBe(1);
  });

  it("passes APNs errors through", async () => {
    const r = await push("dead".repeat(16));
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ reason: "Unregistered", timestamp: 1 });
  });

  it("refuses requests without the secret, other paths, methods, and big bodies", async () => {
    expect((await push(TOKEN, { headers: { "x-relay-secret": "wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/3/device/${TOKEN}`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await push("not-hex")).status).toBe(404);
    expect((await fetch(`${base}/3/other`, { method: "POST", headers: { "x-relay-secret": SECRET } })).status).toBe(404);
    expect((await fetch(`${base}/3/device/${TOKEN}`, { headers: { "x-relay-secret": SECRET } })).status).toBe(405);
    expect((await push(TOKEN, { body: "x".repeat(6000) })).status).toBe(413);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("times out a stuck upstream with 504", async () => {
    expect((await push("5105".repeat(16))).status).toBe(504);
    // The connection is still usable afterwards.
    expect((await push(TOKEN)).status).toBe(200);
  });

  it("requires a real secret", () => {
    expect(() => createRelay({ secret: "short" })).toThrow(/RELAY_SECRET/);
  });
});
