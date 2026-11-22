import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module served as-is to the console
import { renderInspection, verifyWebhookSignature } from "../public/console/inspector.js";

const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("webhook signature check", () => {
  const secret = "whsec_test";
  const body = '{"id":"01JD","message":"hi"}';
  const now = 1_763_750_000_000;
  const t = now / 1000;

  it("accepts a fresh, matching signature", async () => {
    expect(await verifyWebhookSignature(secret, sign(secret, t, body), body, { now })).toMatchObject({ valid: true, age_s: 0 });
  });

  it("rejects a changed body, a wrong secret, and malformed headers", async () => {
    expect((await verifyWebhookSignature(secret, sign(secret, t, body), body + " ", { now })).valid).toBe(false);
    expect((await verifyWebhookSignature("whsec_other", sign(secret, t, body), body, { now })).valid).toBe(false);
    expect(await verifyWebhookSignature(secret, "v1=abc", body, { now })).toMatchObject({ valid: false, reason: expect.stringMatching(/t=<unix>/) });
    expect((await verifyWebhookSignature("", sign(secret, t, body), body, { now })).reason).toMatch(/secret/);
  });

  it("flags old timestamps unless the tolerance is off", async () => {
    const old = sign(secret, t - 3600, body);
    expect(await verifyWebhookSignature(secret, old, body, { now })).toMatchObject({ valid: false, age_s: 3600, reason: expect.stringMatching(/replay/) });
    expect((await verifyWebhookSignature(secret, old, body, { now, toleranceS: null })).valid).toBe(true);
  });
});

describe("renderInspection", () => {
  it("shows a webhook's request and response, escaped", () => {
    const html = renderInspection({
      result: "failed", error: "HTTP 401: <nope>", latency_ms: 12, charged_usd_micros: 10, endpoint: { kind: "webhook" },
      request: { method: "POST", url: "https://h.example.com/in", headers: { "x-subetha-signature": "t=1,v1=ab" }, body: '{"a":1}' },
      response: { status: 401, headers: { "content-type": "text/plain" }, body: "<nope>", truncated: true },
    });
    expect(html).toContain("POST https://h.example.com/in");
    expect(html).toContain("x-subetha-signature: t=1,v1=ab");
    expect(html).toContain("HTTP 401");
    expect(html).toContain("&lt;nope&gt;");
    expect(html).not.toContain("<nope>");
    expect(html).toContain("truncated");
  });

  it("shows the message and provider outcome for other transports", () => {
    const html = renderInspection({ result: "delivered", latency_ms: 5, charged_usd_micros: 500, endpoint: { kind: "email" }, message: { id: "m1", message: "hi" }, detail: { id: "prov-1" } });
    expect(html).toContain("Provider");
    expect(html).toContain("prov-1");
    expect(html).toContain("$0.000500");
  });
});
