# Agents (MCP, llms.txt)

Agents are devices too. An AI agent can publish to a topic (notify a person, trigger a device,
hand work to another agent) and wait for a reply, over the same relay and with the same
prepaid, capped billing as everything else.

## The MCP server

SubEtha runs a remote [Model Context Protocol](https://modelcontextprotocol.io) server at
**`https://subetha.org/mcp`** (Streamable HTTP, JSON responses). Authenticate with a bearer token.

| Tool | What it does |
|---|---|
| `publish` | Publish a message (`topic`, `message`, and optionally `title`, `priority`, `tags`, `click`, `route_mode`, `max_cost_usd`, `idempotency_key`). Returns the stored message. |
| `poll` | Cached messages on one or more topics (comma-separated) since an id, a Unix time, a duration like `10m`, or `all`; optional `priority` and `tags` filters. |
| `wait_for_message` | Long-poll: wait up to `timeout_s` (≤ 50) seconds for the next message on a topic after `since` (default: now). Returns the message or `{"timeout": true}`. |
| `list_topics` | Topics the account owns, with their policies. |
| `create_topic` | Create a topic in your namespace (or a secret `t_` topic), or update its policy. |
| `estimate_cost` | Dry run: the delivery plan and price of a message, without sending it. |

Tools call the public API in-process with the agent's own credentials, so token scopes, topic
policies, spend caps, and prepaid charges apply exactly as they would to any other client.

### Connecting

Claude Code:

<!-- include: samples/mcp/claude-code.sh -->

Clients that read an `mcp.json` (or similar) configuration:

<!-- include: samples/mcp/mcp.json -->

Give the agent its **own token**: scoped to the topics it needs, with a daily cap and no
`sms`/`voice` unless you mean it. For example
`{"scopes": ["publish:@me/agent-out", "subscribe:@me/agent-in"], "daily_cap_usd": 0.5}`.
Unauthenticated requests get a 401 whose `WWW-Authenticate` header points at
`/.well-known/oauth-protected-resource` (RFC 9728).

### On the wire

What an MCP client sends, as raw JSON-RPC:

<!-- include: samples/mcp/tools-call.sh -->

<!-- include: samples/ts/mcp.ts#snippet -->

### Patterns

- **Human in the loop:** `publish` a question to a topic your phone subscribes to (push or SMS),
  then `wait_for_message` on a reply topic. Reply from the console, ntfy, or Slack.
- **Agent to agent:** each agent waits on its own inbox topic and publishes to the other's.
- **Check before spending:** call `estimate_cost` before an `all`-mode alarm.

## llms.txt

Machine-readable docs for agents that read the web:

- [`/llms.txt`](https://subetha.org/llms.txt): a summary and links in the
  [llmstxt.org](https://llmstxt.org) format.
- [`/llms-full.txt`](https://subetha.org/llms-full.txt): every docs page in one file.
- Every docs page is also available as Markdown: replace `.html` with `.md`.
- [`/openapi.yaml`](https://subetha.org/openapi.yaml): the complete HTTP API (OpenAPI 3.1).

## Agent-friendly API details

- Errors are JSON with stable codes ([list](api.md#errors)); `402` responses say exactly how much
  money is missing.
- `Idempotency-Key` makes retries safe; `X-Dry-Run: 1` previews cost.
- Tokens can be capped per day and in total, limited to transports, and expire.
