#!/usr/bin/env bash
# Publish with ntfy headers: title, priority, tags, click URL, action buttons, Markdown.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -H "Title: Front door" \
  -H "Priority: high" \
  -H "Tags: door,warning" \
  -H "Click: https://cam.example.com/front" \
  -H "Actions: view, Open camera, https://cam.example.com/front; http, Lock door, https://home.example.com/lock, clear=true" \
  -H "Markdown: yes" \
  -d "**Opened** at $(date +%H:%M)" \
  "$SUBETHA_URL/@me/doorbell"

# The same thing with query parameters (handy where you can't set headers):
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" -X POST \
  "$SUBETHA_URL/@me/doorbell?title=Front%20door&priority=4&tags=door&message=Opened"
