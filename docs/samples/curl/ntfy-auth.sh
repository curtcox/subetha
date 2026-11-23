#!/usr/bin/env bash
# Credentials the way ntfy clients send them.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.us}"

# HTTP Basic with an empty username and the token as the password:
curl -sS -u ":$SUBETHA_TOKEN" -d "hi" "$SUBETHA_URL/@me/test"

# ?auth= with base64url("Bearer <token>") (no padding), for clients that can't set headers:
AUTH=$(printf 'Bearer %s' "$SUBETHA_TOKEN" | base64 | tr -d '=\n' | tr '+/' '-_')
curl -sS "$SUBETHA_URL/@me/test/json?poll=1&auth=$AUTH"

# The ntfy CLI and apps work too: point them at the server and use the token.
#   ntfy publish --token "$SUBETHA_TOKEN" https://subetha.us/t_mfrggzdfmztwq2lknnwg23tpoa "hi"
