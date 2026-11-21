#!/usr/bin/env bash
# Attach a file (up to 15 MB): the body is the file, X-Filename names it, and the message text
# goes in X-Message. The publisher pays for the upload and its storage until the message expires.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"

curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -T snapshot.jpg \
  -H "X-Filename: snapshot.jpg" \
  -H "Content-Type: image/jpeg" \
  -H "X-Message: Motion at the front door" \
  "$SUBETHA_URL/@me/doorbell"
# {"id":"01JD…","attachment":{"name":"snapshot.jpg","url":"https://subetha.org/file/01jd…/snapshot.jpg","size":81234,"type":"image/jpeg"},…}

# Or link a file that's already hosted somewhere (no upload, no storage charge):
curl -sS -H "Authorization: Bearer $SUBETHA_TOKEN" \
  -H "X-Attach: https://example.com/reports/weekly.pdf" \
  -d "Weekly report" \
  "$SUBETHA_URL/@me/reports"
