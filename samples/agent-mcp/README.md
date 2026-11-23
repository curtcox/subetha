# Agents: SubEtha over MCP

SubEtha runs a remote MCP server at `https://subetha.us/mcp` (Streamable HTTP, JSON-RPC). Its
tools are `publish`, `poll`, `wait_for_message` (long-poll), `list_topics`, `create_topic` and
`estimate_cost`. Use a token scoped to the topics the agent may touch, with a daily cap:

```bash
subetha token create --scopes publish:@me/agent,subscribe:@me/agent --daily-cap 1 --name agent
```

## Claude Code

```bash
claude mcp add --transport http subetha https://subetha.us/mcp --header "Authorization: Bearer $TOKEN"
```

Then ask, for example, "publish 'build finished' to @me/agent, then wait for my reply on it".

## Claude Desktop

Add [`claude_desktop_config.json`](claude_desktop_config.json) to your Claude Desktop config. It
bridges the remote server with `mcp-remote` and passes the bearer header. Desktop builds that
support remote connectors natively can add `https://subetha.us/mcp` under Settings →
Connectors instead.

## Any client: plain fetch

[`call-mcp.mjs`](call-mcp.mjs) runs `initialize → tools/list → estimate_cost → publish →
wait_for_message` with nothing but `fetch`:

```bash
SUBETHA_TOKEN=se_... node samples/agent-mcp/call-mcp.mjs @me/agent
SUBETHA_URL=http://localhost:8787 SUBETHA_TOKEN=se_dev... node samples/agent-mcp/call-mcp.mjs @dev/agent
```
