#!/usr/bin/env bash
# Deliver a topic by email: add the address, verify it with the emailed code, subscribe it.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")

EP=$(curl -sS "${AUTH[@]}" -d '{"kind":"email","address":"me@example.com","name":"inbox"}' \
  "$SUBETHA_URL/v1/endpoints" | jq -r .id)

read -rp "Code from the email: " CODE
curl -sS "${AUTH[@]}" -d "{\"code\":\"$CODE\"}" "$SUBETHA_URL/v1/endpoints/$EP/verify"

curl -sS "${AUTH[@]}" -d "{\"topic\":\"@me/alerts\",\"endpoint_id\":\"$EP\"}" "$SUBETHA_URL/v1/subscriptions"
