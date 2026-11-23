import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processJob } from "../src/delivery/consumer.ts";
import { twilioSignature } from "../src/delivery/twilio.ts";
import { topicStub } from "../src/durable/topic.ts";
import type { DeliveryJob, Env } from "../src/types.ts";
import { auth, BASE, bootstrap, publish } from "./helpers.ts";

const E = env as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

async function twilioPost(path: string, params: Record<string, string>) {
  const url = `${E.BASE_URL}${path}`;
  const sig = await twilioSignature(E.TWILIO_AUTH_TOKEN!, url, params);
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(params).toString(),
  });
}

describe("Twilio WhatsApp transport", () => {
  it("verifies, delivers outbound (with media), and handles inbound messages, ACK, and STOP", async () => {
    const a = await bootstrap("wauser", 10);
    const sent: { url: string; params: Record<string, string> }[] = [];
    const realFetch = fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/Messages.json")) {
        const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
        sent.push({ url, params });
        return new Response(JSON.stringify({ sid: `SM_WA_${sent.length}` }), { status: 201 });
      }
      return realFetch(input, init);
    });

    // International WhatsApp requires country opt-in.
    const ukBlocked = await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ kind: "whatsapp", address: "+447700900123" }),
    });
    expect(ukBlocked.status).toBe(403);

    // Create a US WhatsApp endpoint (accepts optional whatsapp: prefix and normalizes to E.164).
    const created = await SELF.fetch(`${BASE}/v1/endpoints`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ kind: "whatsapp", address: "whatsapp:+14155550199", name: "My WhatsApp" }),
    });
    expect(created.status).toBe(201);
    const ep = (await created.json()) as { id: string; kind: string; verified: boolean };
    expect(ep.kind).toBe("whatsapp");
    expect(ep.verified).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.To).toBe("whatsapp:+14155550199");
    expect(sent[0]!.params.From).toBe("whatsapp:+14155238886");
    const code = /code is (\d{6})/.exec(sent[0]!.params.Body!)![1]!;

    // Verify endpoint with the 6-digit code.
    const verified = await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}/verify`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ code }),
    });
    expect(verified.status).toBe(200);
    expect(((await verified.json()) as { verified: boolean }).verified).toBe(true);

    // Create topic, subscribe the WhatsApp endpoint, and set inbound_topic.
    await SELF.fetch(`${BASE}/v1/topics/@wauser/chat`, {
      method: "PUT",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ policy: {} }),
    });
    const subRes = await SELF.fetch(`${BASE}/v1/subscriptions`, {
      method: "POST",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ topic: "@wauser/chat", endpoint_id: ep.id }),
    });
    expect(subRes.status).toBe(201);
    const sub = (await subRes.json()) as { id: string };

    // Outbound delivery via processJob (including an image attachment URL).
    const pub = await publish("@wauser/chat", "Door opened", auth(a.token, {
      "x-title": "Front door",
      "x-attach": "https://subetha.test/file/f1/snap.jpg",
    }));
    expect(pub.status).toBe(200);
    const msg = (await pub.json()) as { id: string; topic: string; title: string; message: string; attachment: { name: string; url: string } };
    const job: DeliveryJob = {
      topic: "@wauser/chat",
      owner: a.account_id,
      message: { ...msg, attachment: { name: "snap.jpg", url: "https://subetha.test/file/f1/snap.jpg", type: "image/jpeg", size: 1024 } },
      sub: { id: sub.id, transport: "whatsapp", endpoint: ep.id, filter: {} },
      reservation: { ref: `dlv:wa:${msg.id}`, micros: 30_000 },
      attempt: 0,
      sku: "deliver_whatsapp",
    };
    const outcome = await processJob(job, E);
    expect(outcome).toBe("delivered");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.params.To).toBe("whatsapp:+14155550199");
    expect(sent[1]!.params.Body).toContain("Front door");
    expect(sent[1]!.params.MediaUrl).toBe("https://subetha.test/file/f1/snap.jpg");

    // Set inbound_topic on the WhatsApp endpoint and send an inbound WhatsApp message.
    const patch = await SELF.fetch(`${BASE}/v1/endpoints/${ep.id}`, {
      method: "PATCH",
      headers: auth(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ inbound_topic: "@wauser/chat" }),
    });
    expect(patch.status).toBe(200);

    const inbound = await twilioPost("/v1/hooks/twilio/whatsapp", {
      From: "whatsapp:+14155550199",
      To: "whatsapp:+14155238886",
      Body: "Reply from WhatsApp",
      MessageSid: "SM_IN_WA_1",
    });
    expect(inbound.status).toBe(200);

    const polled = await SELF.fetch(`${BASE}/@wauser/chat/json?poll=1`, { headers: auth(a.token) });
    const lines = (await polled.text()).trim().split("\n").map((l) => JSON.parse(l) as { message: string; tags?: string[]; whatsapp_from?: string });
    const received = lines.find((m) => m.message === "Reply from WhatsApp");
    expect(received).toBeDefined();
    expect(received?.tags).toContain("whatsapp");
    expect(received?.whatsapp_from).toBe("+1…0199");

    // Inbound ACK stops escalation.
    expect((await twilioPost("/v1/hooks/twilio/whatsapp", {
      From: "whatsapp:+14155550199",
      Body: `ACK ${msg.id}`,
      MessageSid: "SM_IN_WA_ACK",
    })).status).toBe(200);
    expect(await topicStub(E, "@wauser/chat").isAcked(msg.id)).toBe(true);

    // Inbound STOP unverifies the WhatsApp endpoint.
    expect((await twilioPost("/v1/hooks/twilio/whatsapp", {
      From: "whatsapp:+14155550199",
      Body: "STOP",
      MessageSid: "SM_IN_WA_STOP",
    })).status).toBe(200);
    const list = (await (await SELF.fetch(`${BASE}/v1/endpoints`, { headers: auth(a.token) })).json()) as { endpoints: { id: string; verified: boolean }[] };
    expect(list.endpoints.find((x) => x.id === ep.id)?.verified).toBe(false);

    // Status reports whatsapp configured.
    const st = (await (await SELF.fetch(`${BASE}/v1/status`)).json()) as { transports: { whatsapp: boolean } };
    expect(st.transports.whatsapp).toBe(true);
  });
});
