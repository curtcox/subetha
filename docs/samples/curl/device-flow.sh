#!/usr/bin/env bash
# The owner's side of device enrollment. (The device's side, which signs a proof with its
# Ed25519 key, is easiest with an SDK: see samples/ts/devices.ts.)
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")

# Approve the code a device is showing (the console's "Devices" page does the same):
curl -sS "${AUTH[@]}" -d '{"user_code":"BCDF-GHJK"}' "$SUBETHA_URL/v1/device/approve"

# Or register a device directly. Device ids are public, so this needs the device's proof of key
# possession: the JSON from enrollmentProof() in any SDK, valid for 5 minutes.
curl -sS "${AUTH[@]}" -d '{"device_id":"dev_kxisxbay4mtidk6z454fh3jcjhf3wfpggcprvnuu42wa2fvbeiwa","time":1763750000,"proof":"<base64url signature>","name":"garage-pi","capabilities":["ws","lan"]}' \
  "$SUBETHA_URL/v1/devices"

# List and revoke:
curl -sS "${AUTH[@]}" "$SUBETHA_URL/v1/devices"
curl -sS "${AUTH[@]}" -X DELETE "$SUBETHA_URL/v1/devices/dev_kxisxbay4mtidk6z454fh3jcjhf3wfpggcprvnuu42wa2fvbeiwa"
