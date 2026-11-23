#!/usr/bin/env bash
# Control routing and cost per message.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"

# An alarm: every allowed transport at once, but never more than 5 cents, and never a phone call.
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -H "Priority: urgent" \
  -H "X-Route-Mode: all" \
  -H "X-Max-Cost: 0.05" \
  -H "X-Deny: voice" \
  -d "Smoke detected in the garage" \
  "$SUBETHA_URL/@me/alarm"

# Chatter: free transports only (live WebSocket/SSE/poll), never escalate to paid ones.
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -H "X-Route-Mode: cheap" \
  -d "build 1234 passed" \
  "$SUBETHA_URL/@me/ci"

# Only these transports may be used.
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -H "X-Allow: ws,webpush,email" \
  -d "Weekly report is ready" \
  "$SUBETHA_URL/@me/reports"
