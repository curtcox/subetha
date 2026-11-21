#!/usr/bin/env bash
# Raw: message bodies only, one per line. Good for shell pipelines.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

curl -sSN -H "Authorization: Bearer $SUBETHA_TOKEN" "$SUBETHA_URL/@me/doorbell/raw" |
  while IFS= read -r line; do
    [ -z "$line" ] && continue # keepalive
    notify-send "doorbell" "$line" || echo "doorbell: $line"
  done
