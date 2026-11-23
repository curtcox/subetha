#!/usr/bin/env bash
# Register phone and browser push endpoints. Apps normally do this through the SDK; these are
# the raw calls. Push endpoints need no verification code: the app owns the token.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")

# iOS (APNs device token, hex):
curl -sS "${AUTH[@]}" -d '{"kind":"apns","address":"3f1c…64-or-more-hex-chars…a9","name":"my iPhone"}' "$SUBETHA_URL/v1/endpoints"

# Android (FCM registration token):
curl -sS "${AUTH[@]}" -d '{"kind":"fcm","address":"dQw4w9WgXcQ:APA91b…","name":"my Pixel"}' "$SUBETHA_URL/v1/endpoints"

# Browser (Web Push subscription JSON, as a string; see samples/web/webpush.js):
curl -sS "${AUTH[@]}" -d "$(jq -n --arg sub '{"endpoint":"https://fcm.googleapis.com/fcm/send/…","keys":{"p256dh":"…","auth":"…"}}' \
  '{kind:"webpush", address:$sub, name:"laptop"}')" "$SUBETHA_URL/v1/endpoints"

# Then subscribe each endpoint to topics with POST /v1/subscriptions.
