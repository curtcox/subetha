// Remote MCP server (Streamable HTTP, JSON responses) at /mcp — agents are devices too (PLAN §6).
// Tools call the public HTTP API in-process with the caller's credentials, so every rule
// (auth, scopes, policies, prepaid charges) applies exactly as it does to any other client.
import type { Hono } from "hono";
import { isTopic } from "@subetha/sdk/protocol";
import type { Env, Principal } from "./types.ts";

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const topicProp = { type: "string", description: "Topic name: @handle/name or t_<26 base32 chars>" };
export const TOOLS = [
  {
    name: "publish",
    description: "Publish a message to a topic. Every device subscribed to the topic receives it over whatever transport works. Costs a few micro-dollars; the response includes the stored message.",
    inputSchema: { type: "object", required: ["topic", "message"], properties: {
      topic: topicProp, message: { type: "string" }, title: { type: "string" },
      priority: { type: "integer", minimum: 1, maximum: 5 }, tags: { type: "array", items: { type: "string" } },
      click: { type: "string" }, route_mode: { enum: ["any", "fast", "all", "cheap"] },
      max_cost_usd: { type: "number" }, idempotency_key: { type: "string" },
    } },
  },
  {
    name: "poll",
    description: "Return cached messages on one or more topics (comma-separated) since an id, a unix time, a duration like 10m, or 'all'.",
    inputSchema: { type: "object", required: ["topic"], properties: { topic: topicProp, since: { type: "string", default: "all" }, priority: { type: "string", description: "e.g. 4,5" }, tags: { type: "string" } } },
  },
  {
    name: "wait_for_message",
    description: "Long-poll: wait up to timeout_s seconds for the next message on a topic (after `since`, default now). Returns the message or {timeout:true}.",
    inputSchema: { type: "object", required: ["topic"], properties: { topic: topicProp, since: { type: "string" }, timeout_s: { type: "integer", minimum: 1, maximum: 50, default: 25 } } },
  },
  {
    name: "list_topics",
    description: "List topics owned by the authenticated account, with their policies.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_topic",
    description: "Create (or update the policy of) a topic in your namespace (@handle/name) or a secret t_ topic.",
    inputSchema: { type: "object", required: ["topic"], properties: { topic: topicProp, policy: { type: "object" } } },
  },
  {
    name: "estimate_cost",
    description: "Dry run: return the delivery plan and the cost estimate (µ$) of publishing a message, without delivering it.",
    inputSchema: { type: "object", required: ["topic"], properties: { topic: topicProp, message: { type: "string", default: "test" }, priority: { type: "integer", minimum: 1, maximum: 5 }, route_mode: { enum: ["any", "fast", "all", "cheap"] } } },
  },
] as const;

type Args = Record<string, unknown>;
type Call = (path: string, init?: RequestInit) => Promise<Response>;

async function asJson(r: Response): Promise<unknown> {
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(text), { status: r.status });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const enc = encodeURIComponent;
const topicPath = (t: string) => t.split(",").map((x) => x.split("/").map(enc).join("/")).join(",");

async function runTool(name: string, a: Args, call: Call): Promise<unknown> {
  const topic = String(a.topic ?? "");
  if (name !== "list_topics" && !topic.split(",").every(isTopic)) throw new Error("invalid topic");
  switch (name) {
    case "publish": {
      const env: Record<string, unknown> = { topic, message: String(a.message ?? "") };
      for (const k of ["title", "priority", "tags", "click"]) if (a[k] !== undefined) env[k] = a[k];
      if (a.route_mode || a.max_cost_usd !== undefined) env.route = { mode: a.route_mode, max_cost_usd_micros: a.max_cost_usd !== undefined ? Math.floor(Number(a.max_cost_usd) * 1e6) : undefined };
      return asJson(await call("/", { method: "POST", body: JSON.stringify(env), headers: { "content-type": "application/json", ...(a.idempotency_key ? { "idempotency-key": String(a.idempotency_key) } : {}) } }));
    }
    case "estimate_cost": {
      const env: Record<string, unknown> = { topic, message: String(a.message ?? "test") };
      if (a.priority) env.priority = a.priority;
      if (a.route_mode) env.route = { mode: a.route_mode };
      return asJson(await call("/", { method: "POST", body: JSON.stringify(env), headers: { "content-type": "application/json", "x-dry-run": "1" } }));
    }
    case "poll": {
      const q = new URLSearchParams({ poll: "1", since: String(a.since ?? "all") });
      if (a.priority) q.set("priority", String(a.priority));
      if (a.tags) q.set("tags", String(a.tags));
      const r = await call(`/${topicPath(topic)}/json?${q}`);
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(text), { status: r.status });
      return { messages: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
    }
    case "wait_for_message": {
      const timeout = Math.min(Math.max(Number(a.timeout_s ?? 25), 1), 50) * 1000;
      const q = new URLSearchParams();
      if (a.since) q.set("since", String(a.since));
      const r = await call(`/${topicPath(topic)}/json${q.size ? `?${q}` : ""}`);
      if (!r.ok) throw Object.assign(new Error(await r.text()), { status: r.status });
      // Read bytes directly: cancelling a pipeThrough(TextDecoderStream) chain leaves a rejected
      // internal pipe promise in workerd.
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<null>((res) => { timer = setTimeout(() => res(null), timeout); });
      let buf = "";
      let readPending = false;
      try {
        for (;;) {
          readPending = true;
          const chunk = await Promise.race([reader.read().then((r) => { readPending = false; return r; }, () => ({ done: true as const, value: undefined })), timedOut]);
          if (!chunk || chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            const m = JSON.parse(line) as { event?: string };
            if (m.event === "message") return { message: m };
          }
        }
        return { timeout: true };
      } finally {
        if (timer !== null) clearTimeout(timer);
        // Close the subscription. Cancelling with a read still pending (the timeout case) leaves
        // a rejected promise inside workerd; the subrequest is closed anyway when this request ends.
        if (!readPending) reader.cancel("done").catch(() => {});
      }
    }
    case "list_topics":
      return asJson(await call("/v1/topics"));
    case "create_topic":
      return asJson(await call(`/v1/topics/${topic}`, { method: "PUT", body: JSON.stringify({ policy: a.policy ?? {} }), headers: { "content-type": "application/json" } }));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

interface RpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> }

export function registerMcp(app: App) {
  app.get("/.well-known/oauth-protected-resource", (c) => c.json({
    resource: `${c.env.BASE_URL}/mcp`,
    authorization_servers: c.env.CLERK_ISSUER ? [c.env.CLERK_ISSUER] : [],
    bearer_methods_supported: ["header"],
    resource_documentation: `${c.env.BASE_URL}/docs/agents.html`,
  }));

  app.get("/mcp", (c) => c.json({ error: "use POST (Streamable HTTP, JSON responses)" }, 405, { allow: "POST" }));

  app.post("/mcp", async (c) => {
    const authz = c.req.header("authorization");
    if (!authz) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "authentication required" } }, 401, {
        "www-authenticate": `Bearer resource_metadata="${c.env.BASE_URL}/.well-known/oauth-protected-resource"`,
      });
    }
    let body: RpcRequest | RpcRequest[];
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const origin = new URL(c.req.url).origin;
    const call: Call = (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", authz);
      return Promise.resolve(app.fetch(new Request(`${origin}${path}`, { ...init, headers }), c.env, c.executionCtx));
    };
    const handle = async (req: RpcRequest) => {
      const id = req.id ?? null;
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      switch (req.method) {
        case "initialize": {
          const asked = String(req.params?.protocolVersion ?? "");
          return ok({
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "subetha", version: "0.1.0" },
            instructions: "SubEtha relays messages between devices over any transport. Use publish to send, wait_for_message or poll to receive, and estimate_cost to preview the price. All usage is prepaid from the account balance.",
          });
        }
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: TOOLS });
        case "tools/call": {
          const name = String(req.params?.name ?? "");
          try {
            const result = await runTool(name, (req.params?.arguments ?? {}) as Args, call);
            return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
          } catch (e) {
            return ok({ content: [{ type: "text", text: (e as Error).message }], isError: true });
          }
        }
        default:
          if (req.method.startsWith("notifications/")) return null;
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
      }
    };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(body);
    return out ? c.json(out) : c.body(null, 202);
  });
}
