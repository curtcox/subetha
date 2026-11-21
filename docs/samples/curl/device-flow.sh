#!/usr/bin/env bash
# Enroll a headless device (CLI, Raspberry Pi, ESP32 bridge) with the device flow:
# the device shows a code, you approve it in the console, the device receives its credentials.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

START=$(curl -sS -H "Content-Type: application/json" \
  -d '{"name":"garage-pi","capabilities":["ws","lan","ble"]}' \
  "$SUBETHA_URL/v1/device/code")
echo "Open $(jq -r .verification_uri <<<"$START") and enter $(jq -r .user_code <<<"$START")"

DEVICE_CODE=$(jq -r .device_code <<<"$START")
INTERVAL=$(jq -r '.interval // 5' <<<"$START")
while :; do
  sleep "$INTERVAL"
  RESP=$(curl -sS -H "Content-Type: application/json" -d "{\"device_code\":\"$DEVICE_CODE\"}" "$SUBETHA_URL/v1/device/token")
  case "$(jq -r '.error // empty' <<<"$RESP")" in
    authorization_pending) continue ;;
    slow_down) INTERVAL=$((INTERVAL + 5)) ;;
    "") echo "$RESP"; break ;;
    *) echo "enrollment failed: $RESP" >&2; exit 1 ;;
  esac
done
