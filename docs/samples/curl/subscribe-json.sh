#!/usr/bin/env bash
# Stream messages as newline-delimited JSON (one envelope per line).
# The first line is an "open" event; "keepalive" events arrive periodically.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

curl -sSN -H "Authorization: Bearer $SUBETHA_TOKEN" \
  "$SUBETHA_URL/@me/doorbell/json"

# Pipe it through jq to print just the messages:
#   curl -sSN -H "Authorization: Bearer $SUBETHA_TOKEN" "$SUBETHA_URL/@me/doorbell/json" \
#     | jq --unbuffered -r 'select(.event == null or .event == "message") | .message'
