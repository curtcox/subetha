#!/usr/bin/env bash
# Add SubEtha as a remote MCP server in Claude Code. Use a scoped, spend-capped token.
set -euo pipefail

claude mcp add --transport http subetha https://subetha.org/mcp \
  --header "Authorization: Bearer $SUBETHA_TOKEN"
