#!/usr/bin/env bash
# Create or configure a topic. PUT replaces the whole policy.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"

curl -sS -X PUT -H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json" -d '{
  "policy": {
    "public_publish": true,
    "anon_rate_per_min": 10,
    "anon_daily_cap_micros": 200000,
    "require_signature": false,
    "allow_transports": ["ws", "sse", "poll", "webpush", "email", "sms"],
    "min_priority": { "sms": 4 },
    "max_cost_per_message_micros": 20000,
    "daily_cap_micros": 1000000,
    "retention_s": 86400,
    "quiet_hours": { "start": "22:00", "end": "07:00" }
  }
}' "$SUBETHA_URL/v1/topics/@me/doorbell"

# Pause it (kill switch), then list your topics:
curl -sS -X PUT -H "Authorization: Bearer $SUBETHA_TOKEN" -d '{"policy":{"paused":true}}' "$SUBETHA_URL/v1/topics/@me/doorbell"
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" "$SUBETHA_URL/v1/topics"
