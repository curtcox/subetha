import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isAssetRequest } from "../src/app.ts";
import { BASE } from "./helpers.ts";

// The anonymous limiter is 60 requests a minute per IP (wrangler.jsonc). Each test uses its own
// cf-connecting-ip so the counters don't leak into other tests.
const from = (ip: string) => ({ "cf-connecting-ip": ip });

describe("rate limits", () => {
  it("does not count static assets against the anonymous limit", async () => {
    // A few console page loads in a minute (the e2e suite found this: a module 429'd and the console never started).
    for (let i = 0; i < 70; i++) {
      const path = ["/console/", "/console/console.js", "/style.css", "/"][i % 4]!;
      const r = await SELF.fetch(`${BASE}${path}`, { headers: from("203.0.113.10") });
      expect(r.status, `${path} #${i}`).not.toBe(429);
      await r.body?.cancel();
    }
  });

  it("still limits anonymous API calls and subscriptions", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) {
      const r = await SELF.fetch(`${BASE}/v1/prices`, { headers: from("203.0.113.11") });
      statuses.push(r.status);
      await r.body?.cancel();
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("classifies asset requests", () => {
    expect(isAssetRequest("GET", "/console/console.js")).toBe(true);
    expect(isAssetRequest("GET", "/docs/publishing.html")).toBe(true);
    expect(isAssetRequest("GET", "/")).toBe(true);
    expect(isAssetRequest("POST", "/")).toBe(false);
    expect(isAssetRequest("GET", "/v1/prices")).toBe(false);
    expect(isAssetRequest("GET", "/file/abc/x.jpg")).toBe(false);
    expect(isAssetRequest("GET", "/mcp")).toBe(false);
    expect(isAssetRequest("GET", "/.well-known/oauth-protected-resource")).toBe(false);
    expect(isAssetRequest("GET", "/@alice/doorbell/json")).toBe(false);
    expect(isAssetRequest("GET", "/t_abcdefghijklmnopqrstuvwxyz/sse")).toBe(false);
    expect(isAssetRequest("GET", "/@alice/doorbell")).toBe(false); // redirects to the console
    expect(isAssetRequest("GET", "/%E0%A4%A")).toBe(false);
  });
});
