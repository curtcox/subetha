#!/usr/bin/env bash
# Slack: install the app in a workspace, then bind a channel to a topic (both directions).
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")

# 1. Open the install URL in a browser and approve. You land back in the console.
curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/slack/install" | jq -r .url

# 2. The workspaces you installed it in, with their team ids.
curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/slack/teams" | jq -r '.teams[] | "\(.team_id)  \(.team_name)"'

# 3. Bind #alerts (channel id C0123456789) in team T0123456 to @me/alerts.
#    inbound: channel messages publish to the topic; outbound: topic messages post to the channel.
curl -sS "${AUTH[@]}" -d '{
  "team_id": "T0123456",
  "channel": "C0123456789",
  "topic": "@me/alerts",
  "inbound": true,
  "outbound": true
}' "$SUBETHA_URL/v1/slack/bindings"
