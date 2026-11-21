#!/usr/bin/env bash
# Publish a message: the body is the message text.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -d "Backup done" \
  "$SUBETHA_URL/@me/backups"
