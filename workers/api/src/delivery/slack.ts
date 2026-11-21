// Slack: chat.postMessage out; Events API in (see hooks in control.ts).
import { hmacSha256Hex, timingSafeEqual } from "../crypto.ts";
import { httpFailure, loadEndpoint, PermanentError, registerSender, renderText } from "./senders.ts";

export async function postSlackMessage(token: string, channel: string, text: string, blocks?: unknown[]): Promise<{ ts: string }> {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text, blocks, unfurl_links: false }),
  });
  if (!r.ok) throw httpFailure(r.status, await r.text());
  const j = (await r.json()) as { ok: boolean; ts?: string; error?: string };
  if (!j.ok) {
    const permanent = ["channel_not_found", "not_in_channel", "is_archived", "invalid_auth", "account_inactive", "token_revoked", "msg_too_long"];
    if (permanent.includes(j.error ?? "")) throw new PermanentError(`slack: ${j.error}`);
    throw new Error(`slack: ${j.error}`);
  }
  return { ts: j.ts! };
}

/** Verifies X-Slack-Signature (v0) with a 5-minute window. */
export async function verifySlackSignature(secret: string, body: string, ts: string | null, sig: string | null, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!ts || !sig || Math.abs(nowSec - Number(ts)) > 300) return false;
  return timingSafeEqual(`v0=${await hmacSha256Hex(secret, `v0:${ts}:${body}`)}`, sig);
}

registerSender("slack", async (job, env) => {
  const ep = await loadEndpoint(env, job.sub.endpoint);
  const token = String(ep.cfg.bot_token ?? env.SLACK_BOT_TOKEN ?? "");
  if (!token) throw new PermanentError("no Slack token for this endpoint");
  const m = job.message;
  const text = renderText(m, 3000);
  const r = await postSlackMessage(token, ep.address, text, [
    { type: "section", text: { type: "mrkdwn", text: `${m.title ? `*${m.title.replace(/[*_~]/g, "")}*\n` : ""}${(m.enc ? "[encrypted]" : m.message ?? "").slice(0, 2900)}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `\`${job.topic}\`${m.click ? ` · <${m.click}|open>` : ""}` }] },
  ]);
  return { detail: r };
});
