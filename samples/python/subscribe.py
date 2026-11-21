"""Doorbell inbox: subscribe and print each message (reconnects and resumes from the last id).

    pip install -e sdk/python
    SUBETHA_TOKEN=se_... python samples/python/subscribe.py [@me/doorbell] [--since 1h]

Env: SUBETHA_TOKEN (required), SUBETHA_URL (default https://subetha.org).
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime

from subetha import Client, SubEthaError


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("topic", nargs="?", default="@me/doorbell")
    ap.add_argument("--since", default=None, help="all, 10m, a unix time, or a message id")
    args = ap.parse_args()
    token = os.environ.get("SUBETHA_TOKEN")
    if not token:
        print("set SUBETHA_TOKEN", file=sys.stderr)
        return 2
    with Client(os.environ.get("SUBETHA_URL", "https://subetha.org"), token=token) as c:
        try:
            for msg in c.subscribe(args.topic, since=args.since):
                when = datetime.fromtimestamp(msg.get("time", 0)).strftime("%H:%M:%S")
                title = f"{msg['title']}: " if msg.get("title") else ""
                print(f"{when} {title}{msg.get('message', '')}", flush=True)
        except SubEthaError as e:
            print(f"{e.code} (HTTP {e.http}): {e.message}", file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
