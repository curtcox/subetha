// Call the MCP server's tools directly (JSON-RPC over Streamable HTTP). Agent frameworks' MCP
// clients do this for you; this shows what goes over the wire.
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch = globalThis.fetch }: SampleContext) {
  // #region snippet
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    return ((await r.json()) as { result: any }).result; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const callTool = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).structuredContent;

  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sample", version: "1" } });
  const tools = (await rpc("tools/list")).tools.map((t: { name: string }) => t.name);
  const estimate = await callTool("estimate_cost", { topic, message: "Deploy finished", priority: 4 });
  const sent = await callTool("publish", { topic, message: "Deploy finished", priority: 4, tags: ["deploy"] });
  const inbox = await callTool("poll", { topic, since: "all" });
  console.log(tools, estimate.estimate_usd_micros, sent.id, inbox.messages.length);
  // #endregion snippet
  return { tools, estimate, sent, inbox };
}
