"""Publish with the Python SDK (pip install subetha)."""
import os

from subetha import Client, SubEthaError

client = Client(os.environ.get("SUBETHA_URL", "https://subetha.org"), token=os.environ["SUBETHA_TOKEN"])

msg = client.publish(
    "@me/backups",
    "Backup finished in 4m12s",
    title="nightly-backup",
    priority="high",
    tags=["backup"],
    idempotency_key="backup-2026-11-21",
)
print("published", msg["id"])

# Route control and a dry run: what would an alarm cost?
estimate = client.publish("@me/alarm", "Smoke detected", priority=5, route={"mode": "all", "deny": ["voice"]}, dry_run=True)
print("estimate:", estimate["estimate_usd_micros"], "µ$")

try:
    client.publish("@someone-else/topic", "hi")
except SubEthaError as e:
    print(e.code, e.http, e.message)  # e.g. forbidden 403
