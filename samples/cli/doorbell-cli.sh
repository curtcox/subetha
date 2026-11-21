#!/usr/bin/env bash
#
# doorbell-cli.sh - the doorbell flow with the `subetha` CLI (npx subetha …, from sdk/js).
#
#   samples/cli/doorbell-cli.sh <token> [@me/doorbell]
#
# Env: SUBETHA_URL to target a local relay (wrangler dev) instead of https://subetha.org;
#      SUBETHA_CLI to use another command (e.g. "node sdk/js/bin/subetha.js" in a checkout).

set -euo pipefail

token="${1:?usage: doorbell-cli.sh <token> [topic]}"
topic="${2:-@me/doorbell}"
read -r -a cli <<< "${SUBETHA_CLI:-npx --yes -p @subetha/sdk subetha}"
subetha() { "${cli[@]}" "$@"; }

echo "== login (saves the token for later commands)"
subetha login "$token" ${SUBETHA_URL:+--url "$SUBETHA_URL"}

echo "== subscribe in the background"
subetha sub "$topic" --since 1h &
sub=$!
trap 'kill $sub 2>/dev/null' EXIT
sleep 1

echo "== ring"
subetha pub "$topic" ding -t Doorbell --tags bell

echo "== route & cost (dry run)"
subetha cost "$topic" ding --mode all --max-cost 0.05

echo "== balance"
subetha balance

sleep 2
