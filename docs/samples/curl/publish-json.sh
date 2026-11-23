#!/usr/bin/env bash
# Publish a JSON envelope to POST / (ntfy JSON publishing, plus every SubEtha field).
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"

curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "@me/alerts",
    "title": "Disk almost full",
    "message": "/var is at 91%",
    "priority": "high",
    "tags": ["warning", "disk"],
    "click": "https://grafana.example.com/d/disk",
    "route": { "mode": "any", "max_cost_usd_micros": 20000, "deny": ["voice"] }
  }' \
  "$SUBETHA_URL/"
