import { describe, expect, it } from "vitest";
import * as sdk from "@subetha/sdk";
import * as rn from "../src/index.ts";

/** Minimal WebSocket stand-in: records the URL and sent frames, lets the test push messages. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  emit(data: unknown) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) });
  }
}

describe("@subetha/react-native", () => {
  it("re-exports the TypeScript SDK", () => {
    expect(rn.SubEtha).toBe(sdk.SubEtha);
    expect(rn.SubEthaError).toBe(sdk.SubEthaError);
    expect(rn.signRequest).toBe(sdk.signRequest);
  });

  it("picks WebSocket for one topic and polling otherwise", () => {
    expect(rn.rnTransport("@a/b", true)).toBe("ws");
    expect(rn.rnTransport(["@a/b", "@a/c"], true)).toBe("poll");
    expect(rn.rnTransport("@a/b,@a/c", true)).toBe("poll");
    expect(rn.rnTransport("@a/b", false)).toBe("poll");
  });

  it("publishes with fetch like the JS SDK", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(init.body as string);
    }) as unknown as typeof globalThis.fetch;
    const c = rn.createClient({ baseUrl: "https://x.test", token: "se_t", fetch });
    const m = await c.publish("@a/b", "ding", { title: "Front door" });
    expect(m).toEqual({ topic: "@a/b", message: "ding", title: "Front door" });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer se_t");
  });

  it("subscribes over WebSocket, dedupes and acks over the socket", async () => {
    const c = new rn.SubEtha({ baseUrl: "https://x.test", token: "se_t", WebSocket: FakeWebSocket as unknown as typeof WebSocket });
    const got: string[] = [];
    const g = globalThis as { WebSocket?: unknown };
    const prev = g.WebSocket;
    g.WebSocket = FakeWebSocket;
    try {
      const sub = rn.subscribe(c, "@a/b", (m) => { got.push(m.message ?? ""); });
      const ws = FakeWebSocket.last!;
      expect(ws.url).toMatch(/^wss:\/\/x\.test\/%40a\/b\/ws\?auth=/);
      ws.emit({ event: "open", topic: "@a/b" });
      ws.emit({ id: "01JD0000000000000000000001", topic: "@a/b", message: "ding", event: "message" });
      ws.emit({ id: "01JD0000000000000000000001", topic: "@a/b", message: "ding", event: "message" });
      await new Promise((r) => setTimeout(r, 10));
      expect(got).toEqual(["ding"]);
      expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ event: "ack", id: "01JD0000000000000000000001" }]);
      sub.close();
      expect(sub.closed).toBe(true);
    } finally {
      g.WebSocket = prev;
    }
  });

  it("loadCore returns null without the native package and the module when present", async () => {
    expect(await rn.loadCore()).toBeNull();
    expect(await rn.loadCore(() => { throw new Error("not installed"); })).toBeNull();
    expect(await rn.loadCore(async () => { throw new Error("not installed"); })).toBeNull();
    expect(await rn.loadCore(async () => ({ default: {} }))).toBeNull();
    const fake = { signEnvelopeJson: () => "{}", verifyEnvelopeJson: () => true };
    expect(await rn.loadCore(async () => ({ default: fake }))).toBe(fake);
    // The shape ubrn generates: named exports plus a per-crate namespace as the default.
    expect(await rn.loadCore(() => ({ default: { subetha_core: fake } }))).toBe(fake);
    const generated = { ...fake, default: { subetha_core: fake } };
    expect(await rn.loadCore(() => generated)).toBe(generated);
  });
});
