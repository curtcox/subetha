// Publish with plain fetch and ntfy headers: no SDK needed.
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch = globalThis.fetch }: SampleContext) {
  // #region snippet
  const r = await fetch(`${baseUrl}/${topic}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-title": "Front door",
      "x-priority": "high",
      "x-tags": "door,warning",
    },
    body: "Opened",
  });
  if (!r.ok) throw new Error(`publish failed: ${r.status} ${await r.text()}`);
  const msg = (await r.json()) as { id: string; priority?: number; tags?: string[] };
  console.log(`published ${msg.id}; charged ${r.headers.get("x-cost-micros")} µ$`);
  // #endregion snippet
  return { msg, cost: Number(r.headers.get("x-cost-micros")) };
}
