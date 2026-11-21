#!/usr/bin/env bash
# Deliver a topic to a Reticulum/LXMF address (Sideband, NomadNet, MeshChat…) through the hosted gateway.
set -euo pipefail
SUBETHA_URL="${SUBETHA_URL:-https://subetha.org}"
AUTH=(-H "Authorization: Bearer $SUBETHA_TOKEN" -H "Content-Type: application/json")

EP=$(curl -sS "${AUTH[@]}" -d '{"kind":"lxmf","address":"9ecc3b10bc264d1543b9be044d6fda7a","name":"sideband"}' \
  "$SUBETHA_URL/v1/endpoints" | jq -r .id)
curl -sS "${AUTH[@]}" -d "{\"topic\":\"@me/mesh\",\"endpoint_id\":\"$EP\"}" "$SUBETHA_URL/v1/subscriptions"
