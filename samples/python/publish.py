"""Ring the doorbell: dry-run the route/cost, then publish "ding".

    pip install -e sdk/python
    SUBETHA_TOKEN=se_... python samples/python/publish.py [@me/doorbell]

Env: SUBETHA_TOKEN (required), SUBETHA_URL (default https://subetha.us).
"""

from __future__ import annotations

import os
import sys
import time

from subetha import Client, SubEthaError


def main() -> int:
    topic = sys.argv[1] if len(sys.argv) > 1 else "@me/doorbell"
    token = os.environ.get("SUBETHA_TOKEN")
    if not token:
        print("set SUBETHA_TOKEN", file=sys.stderr)
        return 2
    with Client(os.environ.get("SUBETHA_URL", "https://subetha.us"), token=token) as c:
        try:
            est = c.publish(topic, "ding", title="Doorbell", route={"mode": "all"}, dry_run=True)
            print(f"worst case ${est['estimate_usd_micros'] / 1e6:.6f}")
            for step in est.get("plan", []):
                print("  ", step)
            msg = c.publish(topic, "ding", title="Doorbell", tags=["bell"], idempotency_key=f"ring-{int(time.time())}")
            print("published", msg.get("id"))
        except SubEthaError as e:
            print(f"{e.code} (HTTP {e.http}): {e.message}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
