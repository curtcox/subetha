#!/usr/bin/env bash
# Balance, ledger, prices, and a Stripe Checkout top-up.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN")

curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/balance"
# {"available_usd_micros":4981234,"reserved_usd_micros":15000}

curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/ledger?limit=20"
curl -sS "$SUBETHA_URL/v1/prices" | jq '.skus.publish'

# Top up $20: open the returned URL to pay.
curl -sS "${AUTH[@]}" -H "Content-Type: application/json" -d '{"amount_usd": 20}' \
  "$SUBETHA_URL/v1/billing/checkout" | jq -r .url

# A 402 looks like this:
#   {"error":"insufficient_balance","http":402,"message":"…","shortfall_usd_micros":1234}
