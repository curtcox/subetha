#!/usr/bin/env bash
# Publish, look at the message's trace, and acknowledge it.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
TOPIC="@me/alarm"

ID=$(curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" -H "Priority: 5" -d "Water leak" \
  "$SUBETHA_URL/$TOPIC" | jq -r .id)

# Route plan, each delivery attempt, acks, and µ$ per step (topic owner only):
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" "$SUBETHA_URL/v1/traces/$ID?topic=$TOPIC"

# Acknowledge: pending escalation steps (SMS, voice…) are cancelled and their reservations released.
curl -sS -H "Content-Type: application/json" -d "{\"topic\":\"$TOPIC\",\"id\":\"$ID\",\"via\":\"http\"}" \
  "$SUBETHA_URL/v1/ack"
