import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module served as-is to the console
import { renderTrace } from "../public/console/trace.js";

describe("trace viewer", () => {
  it("renders summary, cost breakdown, delivery plan, dropped steps, events, and raw JSON", () => {
    const html: string = renderTrace({
      id: "01JD0000000000000000000001",
      published: 1763750000000,
      publisher: "token:tok_1",
      cost_micros: { publish: 6, live: 2, queued: 15000, retention_nanos: 500 },
      plan: [
        { subscriber: "c_1", transport: "ws", sku: "deliver_live", cost_micros: 2, after_s: 0 },
        { subscriber: "sub_sms", transport: "sms", sku: "deliver_sms_us", cost_micros: 15000, after_s: 60 },
      ],
      dropped: [{ subscriber: "sub_voice", transport: "voice", reason: "quiet hours" }],
      events: [{ at: 1763750061000, sub: "sub_sms", transport: "sms", result: "skipped_acked" }],
      ack: { time: 1763750005000, via: "ws" },
    });
    expect(html).toContain("01JD0000000000000000000001");
    expect(html).toContain("token:tok_1");
    expect(html).toContain("acked");
    expect(html).toContain("deliver_sms_us");
    expect(html).toContain("after 60s if unacked");
    expect(html).toContain("quiet hours");
    expect(html).toContain("skipped_acked");
    expect(html).toContain("$0.015009"); // 6 + 2 + 15000 + ceil(500/1000) = 15009
    expect(html).toContain("Raw JSON");
  });

  it("handles traces with no subscribers and escapes HTML in fields", () => {
    const html: string = renderTrace({
      id: "01JD0000000000000000000002",
      published: 1763750000000,
      publisher: "<script>alert(1)</script>",
      cost_micros: { publish: 6, live: 0, queued: 0, retention_nanos: 0 },
      plan: [],
      dropped: [],
      ack: null,
    });
    expect(html).toContain("not acked");
    expect(html).toContain("No subscribers matched");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
