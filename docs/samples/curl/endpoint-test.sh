#!/usr/bin/env bash
# Send one test message to an endpoint and see exactly what happened (charged as one delivery).
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"
EP="${1:?usage: endpoint-test.sh ep_…}"

curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Hello","message":"Does my signature check work?","priority":4}' \
  "$SUBETHA_URL/v1/endpoints/$EP/test" | jq '{result, error, latency_ms, request, response}'

# For a webhook:
#   "result": "delivered",
#   "request":  {"method":"POST","url":"https://example.com/hooks/subetha",
#                "headers":{"x-subetha-signature":"t=1763750000,v1=…",…},"body":"{\"id\":\"01JD…\",…}"},
#   "response": {"status":200,"headers":{…},"body":"ok","truncated":false}
