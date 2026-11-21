#!/usr/bin/env bash
# Talk to the MCP server with raw JSON-RPC (Streamable HTTP). Agents' MCP clients do this for you.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"
H=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

curl -sS "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' "$SUBETHA_URL/mcp"
curl -sS "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$SUBETHA_URL/mcp"

# Publish, then block until a reply arrives on another topic (or 60 s pass):
curl -sS "${H[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"publish","arguments":{"topic":"@me/agent-out","message":"Deploy v1.2 to prod? Reply yes/no."}}}' "$SUBETHA_URL/mcp"
curl -sS "${H[@]}" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"wait_for_message","arguments":{"topic":"@me/agent-in","timeout_s":60}}}' "$SUBETHA_URL/mcp"
