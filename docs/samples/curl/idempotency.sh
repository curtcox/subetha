#!/usr/bin/env bash
# Safe retries: the same Idempotency-Key returns the original message (with X-Duplicate: 1)
# instead of delivering and charging again.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

for attempt in 1 2 3; do
  if curl -sS --fail-with-body --max-time 10 \
      -H "Authorization: Bearer $SUBETHA_TOKEN" \
      -H "Idempotency-Key: invoice-2041-paid" \
      -d "Invoice 2041 was paid" \
      "$SUBETHA_URL/@me/billing"; then
    break
  fi
  sleep "$attempt"
done
