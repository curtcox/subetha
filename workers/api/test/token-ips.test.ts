import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ipAllowed, parseCidr, parseIp } from "../src/ip.ts";
import { auth, BASE, bootstrap } from "./helpers.ts";

describe("ip matching", () => {
  it("parses IPv4, IPv6, and mapped addresses", () => {
    expect(parseIp("203.0.113.7")).toEqual({ v: 4, n: 0xcb007107n });
    expect(parseIp("::1")).toEqual({ v: 6, n: 1n });
    expect(parseIp("2001:db8::")?.n).toBe(0x20010db8n << 96n);
    expect(parseIp("::ffff:203.0.113.7")).toEqual({ v: 4, n: 0xcb007107n });
    expect(parseIp("[2001:db8::1]")?.v).toBe(6);
    for (const bad of ["", "1.2.3", "1.2.3.256", "01.2.3.4", "1::2::3", "1:2:3:4:5:6:7:8:9", "g::1", "1:2:3:4:5:6:7", "example.com"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it("parses CIDRs", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual({ v: 4, base: 0x0a000000n, bits: 8 });
    expect(parseCidr("2001:db8::/32")?.bits).toBe(32);
    expect(parseCidr("1.2.3.4")?.bits).toBe(32);
    for (const bad of ["10.0.0.0/33", "::/129", "1.2.3.4/x", "1.2.3.4/8/9", "/8"]) expect(parseCidr(bad), bad).toBeNull();
  });

  it("matches addresses against ranges", () => {
    const list = ["203.0.113.0/24", "2001:db8:1::/48", "198.51.100.9"];
    expect(ipAllowed("203.0.113.200", list)).toBe(true);
    expect(ipAllowed("203.0.114.1", list)).toBe(false);
    expect(ipAllowed("198.51.100.9", list)).toBe(true);
    expect(ipAllowed("198.51.100.10", list)).toBe(false);
    expect(ipAllowed("2001:db8:1:ffff::1", list)).toBe(true);
    expect(ipAllowed("2001:db8:2::1", list)).toBe(false);
    expect(ipAllowed("::ffff:203.0.113.5", list)).toBe(true);
    expect(ipAllowed("0.0.0.0", ["0.0.0.0/0"])).toBe(true);
    expect(ipAllowed("::1", ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed(null, ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("junk", ["0.0.0.0/0"])).toBe(false);
  });
});

describe("IP-restricted tokens", () => {
  it("only work from listed addresses", async () => {
    const a = await bootstrap("ipres");
    const r = await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ name: "ci", scopes: ["publish:@ipres/*"], ips: ["203.0.113.0/24", "2001:db8::/32"] }) });
    expect(r.status).toBe(201);
    const { id, token } = (await r.json()) as { id: string; token: string };

    const pub = (ip?: string) => SELF.fetch(`${BASE}/@ipres/ci`, { method: "POST", body: "hi", headers: auth(token, ip ? { "cf-connecting-ip": ip } : {}) });
    expect((await pub("203.0.113.9")).status).toBe(200);
    expect((await pub("2001:db8:5::1")).status).toBe(200);
    const denied = await pub("198.51.100.1");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { message: string }).message).toMatch(/IP/);
    expect((await pub()).status).toBe(403);

    const list = (await (await SELF.fetch(`${BASE}/v1/tokens`, { headers: auth(a.token) })).json()) as { tokens: { id: string; ips: string[] | null }[] };
    expect(list.tokens.find((t) => t.id === id)?.ips).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
    // The admin token (no ips) still works from anywhere.
    expect(list.tokens.find((t) => t.id !== id)?.ips).toBeNull();
  });

  it("rejects malformed ip lists", async () => {
    const a = await bootstrap("ipbad");
    for (const ips of [["10.0.0.0/33"], ["example.com"], "10.0.0.1", [1], Array(33).fill("10.0.0.1")]) {
      const r = await SELF.fetch(`${BASE}/v1/tokens`, { method: "POST", headers: auth(a.token), body: JSON.stringify({ scopes: ["publish"], ips }) });
      expect(r.status, JSON.stringify(ips)).toBe(400);
    }
  });
});
