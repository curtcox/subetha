#!/usr/bin/env bash
# An escalation chain for alarms: push now, SMS after 60 s, a phone call after 180 s, each only
# if nobody has acknowledged the message yet. US numbers only; each is verified with a code.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")
TOPIC="@me/alarm"

SMS=$(curl -sS "${AUTH[@]}" -d '{"kind":"sms","address":"+14155550123"}' "$SUBETHA_URL/v1/endpoints" | jq -r .id)
read -rp "SMS code: " CODE
curl -sS "${AUTH[@]}" -d "{\"code\":\"$CODE\"}" "$SUBETHA_URL/v1/endpoints/$SMS/verify"

VOICE=$(curl -sS "${AUTH[@]}" -d '{"kind":"voice","address":"+14155550123"}' "$SUBETHA_URL/v1/endpoints" | jq -r .id)
read -rp "Code read out on the call: " CODE
curl -sS "${AUTH[@]}" -d "{\"code\":\"$CODE\"}" "$SUBETHA_URL/v1/endpoints/$VOICE/verify"

curl -sS "${AUTH[@]}" -d "{\"topic\":\"$TOPIC\",\"endpoint_id\":\"$SMS\",\"after_s\":60,\"min_priority\":4}" "$SUBETHA_URL/v1/subscriptions"
curl -sS "${AUTH[@]}" -d "{\"topic\":\"$TOPIC\",\"endpoint_id\":\"$VOICE\",\"after_s\":180,\"min_priority\":5}" "$SUBETHA_URL/v1/subscriptions"

# Acknowledge from anywhere to stop the chain: an SDK does it automatically, or reply
# "ACK <id>" to the SMS, press 1 on the call, or:
#   curl -sS -d '{"topic":"@me/alarm","id":"<message id>"}' "$SUBETHA_URL/v1/ack"
