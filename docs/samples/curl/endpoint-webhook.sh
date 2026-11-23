#!/usr/bin/env bash
# Deliver a topic to your server as signed JSON. The secret is shown once.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")

RESP=$(curl -sS "${AUTH[@]}" -d '{"kind":"webhook","address":"https://example.com/hooks/subetha"}' "$SUBETHA_URL/v1/endpoints")
EP=$(jq -r .id <<<"$RESP")
echo "signing secret: $(jq -r .secret <<<"$RESP")"

curl -sS "${AUTH[@]}" -d "{\"topic\":\"@me/deploys\",\"endpoint_id\":\"$EP\",\"filter\":{\"priority\":[4,5]}}" \
  "$SUBETHA_URL/v1/subscriptions"

# Your server receives:
#   POST /hooks/subetha
#   Content-Type: application/json
#   X-SubEtha-Topic: @me/deploys
#   X-SubEtha-Message-Id: 01JD…
#   X-SubEtha-Signature: t=1763750000,v1=<hex HMAC-SHA256(secret, "1763750000.<body>")>
#   {"id":"01JD…","topic":"@me/deploys","message":"…",…}
