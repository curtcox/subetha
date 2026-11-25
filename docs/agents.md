# Agents (MCP, llms.txt)

Agents are devices too. An AI agent can publish to a topic (notify a person, trigger a device,
hand work to another agent) and wait for a reply, over the same relay and with the same
prepaid, capped billing as everything else.

## The MCP server

SubEtha runs a remote [Model Context Protocol](https://modelcontextprotocol.io) server at
**`https://subetha.us/mcp`** (Streamable HTTP, JSON responses). Authenticate with a bearer token.

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

There are two ways to authenticate.

**An API token (recommended for unattended agents).** Give the agent its own token: scoped to
the topics it needs, with a daily cap and no `sms`/`voice` unless you mean it. For example
`{"scopes": ["publish:@me/agent-out", "subscribe:@me/agent-in"], "daily_cap_usd": 0.5}`.

**Sign in with OAuth.** MCP clients that support the
[MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
can connect with no token at all. An unauthenticated request gets a 401 whose
`WWW-Authenticate` header points at `/.well-known/oauth-protected-resource` (RFC 9728); that
names SubEtha's authorization server, where you sign in and approve the client. The client then
sends the access token it got as a bearer token. OAuth sign-in is offered only on deployments
that configure Clerk as the authorization server (`authorization_servers` in that document is
empty otherwise); everywhere else, use an API token.

An OAuth-connected client is deliberately limited:

- It can **publish and subscribe** on your topics (so `publish`, `poll`, `wait_for_message`, and
  `estimate_cost` work), but not manage the account: `list_topics`, `create_topic`, tokens,
  endpoints, and billing need an admin token.
- Each client has its own **daily spend cap**: $1 by default. Change it, or set it to 0 to turn
  OAuth access off, with `PATCH /v1/account {"oauth_daily_cap_micros": 5000000}` or in the
  console's Billing tab.
- A token that names an audience must name this server (`https://subetha.us/mcp`); one issued
  for another resource gets `401` with `error="invalid_token"`, as does an expired one.

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

- [`/llms.txt`](https://subetha.us/llms.txt): a summary and links in the
  [llmstxt.org](https://llmstxt.org) format.
- [`/llms-full.txt`](https://subetha.us/llms-full.txt): every docs page in one file.
- Every docs page is also available as Markdown: replace `.html` with `.md`.
- [`/openapi.yaml`](https://subetha.us/openapi.yaml): the complete HTTP API (OpenAPI 3.1).

## Agent-friendly API details

- Errors are JSON with stable codes ([list](api.md#errors)); `402` responses say exactly how much
  money is missing.
- `Idempotency-Key` makes retries safe; `X-Dry-Run: 1` previews cost.
- Tokens can be capped per day and in total, limited to transports, and expire.
