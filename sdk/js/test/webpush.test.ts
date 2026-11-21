import { describe, expect, it } from "vitest";
import { subscribeWebPush } from "../src/webpush.ts";
import { base64urlDecode } from "../src/protocol/index.ts";

const VAPID = "BK0RdqGr2bQ3tdVhA-kUUW73nHAtrHvDjCE7p0Ar7eBOzJ00UlUfjy4zQydOV_wUvi2iRqCOqRQSEn9bmoiGW0I";

function fakeRegistration(existing: { key: Uint8Array; endpoint: string } | null) {
  const log: string[] = [];
  const mk = (endpoint: string, key: Uint8Array) => ({
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "pk", auth: "au" } }),
    unsubscribe: async () => { log.push(`unsubscribe ${endpoint}`); return true; },
  });
  const reg = {
    pushManager: {
      getSubscription: async () => (existing ? mk(existing.endpoint, existing.key) : null),
      subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        log.push(`subscribe ${o.userVisibleOnly}`);
        return mk("https://push.example/new", o.applicationServerKey);
      },
    },
  };
  return { reg: reg as unknown as ServiceWorkerRegistration, log };
}

describe("subscribeWebPush", () => {
  it("subscribes with the VAPID key and returns the endpoint address JSON", async () => {
    const { reg, log } = fakeRegistration(null);
    const addr = await subscribeWebPush(reg, VAPID);
    expect(JSON.parse(addr)).toEqual({ endpoint: "https://push.example/new", keys: { p256dh: "pk", auth: "au" } });
    expect(log).toEqual(["subscribe true"]);
  });
  it("reuses a subscription made with the same key and replaces one with a different key", async () => {
    const same = fakeRegistration({ key: base64urlDecode(VAPID), endpoint: "https://push.example/old" });
    expect(JSON.parse(await subscribeWebPush(same.reg, VAPID)).endpoint).toBe("https://push.example/old");
    expect(same.log).toEqual([]);
    const other = fakeRegistration({ key: new Uint8Array(65).fill(4), endpoint: "https://push.example/old" });
    expect(JSON.parse(await subscribeWebPush(other.reg, VAPID)).endpoint).toBe("https://push.example/new");
    expect(other.log).toEqual(["unsubscribe https://push.example/old", "subscribe true"]);
  });
});
