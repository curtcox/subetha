#!/usr/bin/env bash
# Poll: return cached messages and close. since= takes a message id, Unix seconds, a duration, or "all".
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN")

# Everything still retained:
curl -sS "${AUTH[@]}" "$SUBETHA_URL/@me/doorbell/json?poll=1&since=all"

# The last hour, high priority only, tagged "door":
curl -sS "${AUTH[@]}" "$SUBETHA_URL/@me/doorbell/json?poll=1&since=1h&priority=4,5&tags=door"

# Several topics at once (comma-separated), resuming after a message id:
curl -sS "${AUTH[@]}" "$SUBETHA_URL/@me/doorbell,@me/alarm/json?poll=1&since=01JD5Z8W3V6X0M3K9Q2T4R7B1C"
