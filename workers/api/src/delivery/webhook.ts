// Webhook delivery: POST the envelope as JSON, HMAC-signed like Stripe:
//   X-SubEtha-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>
import type { Envelope } from "@subetha/sdk/protocol";
import { hmacSha256Hex } from "../crypto.ts";
import { httpFailure, loadEndpoint, registerSender } from "./senders.ts";

export async function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

export interface WebhookRequest { method: "POST"; url: string; headers: Record<string, string>; body: string }

/** The exact request a webhook delivery sends (shared with the endpoint inspector). */
export async function webhookRequest(url: string, secret: string, topic: string, message: Envelope): Promise<WebhookRequest> {
  const body = JSON.stringify(message);
  return {
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      "user-agent": "SubEtha-Webhook/1",
      "x-subetha-topic": topic,
      "x-subetha-message-id": message.id ?? "",
      "x-subetha-signature": await signWebhook(secret, body),
    },
    body,
  };
}

/** Sends a webhook request; redirects are refused (one could point back at the relay or somewhere private). */
export function sendWebhook(req: WebhookRequest): Promise<Response> {
  return fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
}

export async function checkWebhookResponse(r: Response): Promise<void> {
  if (r.status >= 300 && r.status < 400) throw httpFailure(400, `webhook redirected (${r.status}); configure the final URL`);
  if (!r.ok) throw httpFailure(r.status, await r.text());
}

registerSender("webhook", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const r = await sendWebhook(await webhookRequest(ep.address, String(ep.cfg.secret ?? ""), job.topic, job.message));
  await checkWebhookResponse(r);
  return { detail: { status: r.status } };
});
