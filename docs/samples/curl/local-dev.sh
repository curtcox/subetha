#!/usr/bin/env bash
# Run the relay locally and get a funded account and admin token.
set -euo pipefail

# In one terminal (from the repository root):
#   pnpm install && pnpm --filter @subetha/sdk build && pnpm --filter @subetha/site build
#   pnpm --filter @subetha/api exec wrangler d1 migrations apply DB --local
#   pnpm --filter @subetha/api dev          # http://localhost:8787

# In another:
export SUBETHA_URL=http://localhost:8787
SUBETHA_TOKEN=$(curl -sS -X POST "$SUBETHA_URL/v1/dev/bootstrap" \
  -d '{"secret":"local-dev-only","handle":"me","credit_usd":5}' | jq -r .token)
export SUBETHA_TOKEN

curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" -d "hello from localhost" "$SUBETHA_URL/@me/test"
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" "$SUBETHA_URL/@me/test/json?poll=1"
