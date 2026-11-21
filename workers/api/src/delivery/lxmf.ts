// Reticulum/LXMF via the hosted gateway (gateways/reticulum): HMAC-signed POST to its /deliver.
import { signWebhook } from "./webhook.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender } from "./senders.ts";

registerSender("lxmf", async (job, env) => {
  if (!env.LXMF_GATEWAY_URL || !env.LXMF_GATEWAY_SECRET) throw new PermanentError("LXMF gateway is not configured");
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const body = JSON.stringify({ destination: ep.address, message: job.message });
  const r = await fetch(`${env.LXMF_GATEWAY_URL.replace(/\/$/, "")}/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-subetha-signature": await signWebhook(env.LXMF_GATEWAY_SECRET, body) },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw httpFailure(r.status, await r.text());
  return {};
});
