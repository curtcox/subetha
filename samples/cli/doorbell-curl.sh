#!/usr/bin/env bash
#
# doorbell-curl.sh - the doorbell flow with nothing but curl (ntfy-compatible API).
#
#   SUBETHA_TOKEN=se_... samples/cli/doorbell-curl.sh [@me/doorbell]
#
# Env: SUBETHA_TOKEN (required), SUBETHA_URL (default https://subetha.us).

set -euo pipefail

: "${SUBETHA_TOKEN:?set SUBETHA_TOKEN}"
base="${SUBETHA_URL:-https://subetha.us}"
topic="${1:-@me/doorbell}"
auth=(-H "Authorization: Bearer $SUBETHA_TOKEN")

echo "== subscribe (background JSON stream: one message per line)"
curl -sN "${auth[@]}" "$base/$topic/json" > /tmp/doorbell.$$ &
sub=$!
trap 'kill $sub 2>/dev/null; rm -f /tmp/doorbell.$$' EXIT
sleep 1

echo "== ring: publish \"ding\" (ntfy headers)"
curl -s "${auth[@]}" -H "X-Title: Doorbell" -H "X-Tags: bell" -d "ding" "$base/$topic"
echo

echo "== route & cost: dry run (nothing delivered)"
curl -s "${auth[@]}" -H "X-Dry-Run: 1" -H "X-Route-Mode: all" -d "ding" "$base/$topic"
echo

echo "== same publish as JSON, with an idempotency key and a cost cap"
curl -s "${auth[@]}" -H "Content-Type: application/json" -H "Idempotency-Key: ring-$(date +%s)" \
  -d "{\"topic\":\"$topic\",\"message\":\"ding\",\"title\":\"Doorbell\",\"route\":{\"mode\":\"any\",\"max_cost_usd_micros\":20000}}" \
  "$base/"
echo

sleep 2
echo "== inbox (what the subscription received)"
grep '"event":"message"' /tmp/doorbell.$$ || cat /tmp/doorbell.$$

echo "== ack the last message (stops escalation)"
id=$(grep '"event":"message"' /tmp/doorbell.$$ | tail -1 | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$id" ] && curl -s "${auth[@]}" -H "Content-Type: application/json" -d "{\"topic\":\"$topic\",\"id\":\"$id\"}" "$base/v1/ack" && echo

echo "== poll cached messages from the last hour"
curl -s "${auth[@]}" "$base/$topic/json?poll=1&since=1h"
