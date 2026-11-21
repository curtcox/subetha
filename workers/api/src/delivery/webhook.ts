// Webhook delivery: POST the envelope as JSON, HMAC-signed like Stripe:
//   X-SubEtha-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>
import { hmacSha256Hex } from "../crypto.ts";
import { httpFailure, loadEndpoint, registerSender } from "./senders.ts";

export async function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

registerSender("webhook", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const body = JSON.stringify(job.message);
  const r = await fetch(ep.address, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "SubEtha-Webhook/1",
      "x-subetha-topic": job.topic,
      "x-subetha-message-id": job.message.id ?? "",
      "x-subetha-signature": await signWebhook(String(ep.cfg.secret ?? ""), body),
    },
    body,
    redirect: "manual", // a redirect could point back at the relay or somewhere private
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status >= 300 && r.status < 400) throw httpFailure(400, `webhook redirected (${r.status}); configure the final URL`);
  if (!r.ok) throw httpFailure(r.status, await r.text());
  return { detail: { status: r.status } };
});
