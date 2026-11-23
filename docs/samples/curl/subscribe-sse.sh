#!/usr/bin/env bash
# Server-sent events: "id: <message id>" and "data: <envelope JSON>" per event.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"

curl -sSN -H "Authorization: Bearer $SUBETHA_TOKEN" \
  "$SUBETHA_URL/@me/doorbell/sse?since=10m"

# In a browser (EventSource can't set headers, so pass the token as ?auth=):
#   const auth = btoa(`Bearer ${token}`).replace(/=+$/, "");
#   new EventSource(`https://subetha.us/@me/doorbell/sse?auth=${auth}`)
#     .onmessage = (e) => console.log(JSON.parse(e.data).message);
