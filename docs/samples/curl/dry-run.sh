#!/usr/bin/env bash
# Dry run: the route plan and a worst-case cost estimate. Nothing is delivered;
# you pay for one API request.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -H "X-Dry-Run: 1" \
  -H "Priority: 5" \
  -H "X-Route-Mode: all" \
  -d "Smoke detected" \
  "$SUBETHA_URL/@me/alarm"
# {"dry_run":true,"estimate_usd_micros":16612,"plan":[{"transport":"ws",...},{"transport":"sms","after_s":60,...}],"message":{...}}
