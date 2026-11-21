#!/usr/bin/env bash
# The subetha CLI (npx subetha …, or install @subetha/sdk globally).
set -euo pipefail

npx subetha login "$SUBETHA_TOKEN"                  # saves the token (and --url) to your config
npx subetha pub @me/backups "Backup done" -t nightly -p high --tags backup
echo "from stdin" | npx subetha pub @me/backups
npx subetha cost @me/alarm "Smoke" -p 5 --mode all   # dry run: route plan + estimate
npx subetha poll @me/backups --since 1h
npx subetha sub @me/backups,@me/alarm --json         # stream (Ctrl-C to stop)
npx subetha tail @me/backups                         # everything retained, then live
npx subetha balance
npx subetha token create --scopes "publish:@me/*" --daily-cap 1 --name ci
npx subetha token list
