#!/usr/bin/env bash
# Devices enroll at devicebasedauth.org; subetha checks their credentials. Once, on the device
# (the dba CLI keeps its key in the OS keychain or TPM where there is one):
#   dba enroll --aud subetha.us --action subetha:publish --action subetha:subscribe --resource "@me/*"
# You approve it at devicebasedauth.org. After you link that account here (console → Devices →
# Link devicebasedauth.org), the device publishes and subscribes with its own credential:
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
dba curl -sS -d "Backup done" "$SUBETHA_URL/@me/backups"
dba curl -sS "$SUBETHA_URL/@me/backups/json?poll=1"

# The owner lists devices (dba:… for devicebasedauth.org devices, dev_… for signing keys they
# attached) and can pause or revoke them here too:
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN")
curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/devices"
curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/dba/link"
