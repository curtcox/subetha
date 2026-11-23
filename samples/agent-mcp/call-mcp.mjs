#!/usr/bin/env node
// Talks to SubEtha's remote MCP server with plain fetch (Node 18+, no dependencies):
// initialize → tools/list → estimate_cost → publish → wait_for_message.
//
//   SUBETHA_TOKEN=se_... node samples/agent-mcp/call-mcp.mjs [@me/doorbell]
//
// Env: SUBETHA_URL (default https://subetha.us).

const base = (process.env.SUBETHA_URL ?? "https://subetha.us").replace(/\/+$/, "");
const token = process.env.SUBETHA_TOKEN;
const topic = process.argv[2] ?? "@me/doorbell";
if (!token) {
  console.error("set SUBETHA_TOKEN");
  process.exit(2);
}

let nextId = 1;
async function rpc(method, params) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await r.json();
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result;
}

const call = async (name, args) => {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent ?? JSON.parse(res.content[0].text);
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "subetha-sample", version: "0.1.0" } });
console.log("server:", init.serverInfo, "protocol:", init.protocolVersion);

const { tools } = await rpc("tools/list", {});
console.log("tools:", tools.map((t) => t.name).join(", "));

console.log("estimate:", await call("estimate_cost", { topic, message: "ding", route_mode: "all" }));

// Start waiting first, then ring, so the long-poll sees the message.
const since = String(Math.floor(Date.now() / 1000) - 1);
const waiting = call("wait_for_message", { topic, since, timeout_s: 20 });
console.log("published:", await call("publish", { topic, message: "ding", title: "Doorbell", idempotency_key: `mcp-${Date.now()}` }));
console.log("received:", await waiting);
