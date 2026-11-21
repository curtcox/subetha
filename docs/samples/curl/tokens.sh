#!/usr/bin/env bash
# Create, list, and revoke API tokens. Needs a token with the admin scope.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")

# A token for a backup script: publish to one namespace, no telephony, $1/day.
curl -sS "${AUTH[@]}" -d '{
  "name": "backup-script",
  "scopes": ["publish:@me/*"],
  "transports": ["ws", "sse", "poll", "webpush", "email"],
  "daily_cap_usd": 1,
  "expires_in_s": 7776000
}' "$SUBETHA_URL/v1/tokens"

# A publishable token for a public web page: one topic, bound to your origin, tightly capped.
curl -sS "${AUTH[@]}" -d '{
  "name": "website feed",
  "scopes": ["subscribe:@me/status"],
  "origins": ["https://example.com"],
  "daily_cap_usd": 0.25
}' "$SUBETHA_URL/v1/tokens"

curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/tokens"
curl -sS "${AUTH[@]}" -X DELETE "$SUBETHA_URL/v1/tokens/abcdefghijklmnop"
