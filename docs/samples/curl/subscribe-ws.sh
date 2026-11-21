#!/usr/bin/env bash
# WebSocket (one topic per socket). Each frame is one JSON envelope. Send
# {"event":"ack","id":"<message id>"} to acknowledge a message and stop escalation.
# Uses websocat (https://github.com/vi/websocat).
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"
WS_URL="${SUBETHA_URL/https:/wss:}"
WS_URL="${WS_URL/http:/ws:}"

websocat -H "Authorization: Bearer $SUBETHA_TOKEN" "$WS_URL/@me/doorbell/ws"

# Browsers can't set headers on WebSockets, so use ?auth=:
#   const auth = btoa(`Bearer ${token}`).replace(/=+$/, "");
#   const ws = new WebSocket(`wss://subetha.org/@me/doorbell/ws?auth=${auth}`);
#   ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.event === "message") ws.send(JSON.stringify({ event: "ack", id: m.id })); };
