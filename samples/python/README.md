# Python samples

```bash
pip install -e sdk/python
export SUBETHA_TOKEN=se_...
python samples/python/subscribe.py @me/doorbell --since 1h   # terminal 1: the inbox
python samples/python/publish.py @me/doorbell                # terminal 2: dry run, then ring
```

`subscribe.py` uses `Client.subscribe` (NDJSON stream, dedupe, reconnect with `since=<last id>`).
`publish.py` prints the dry-run plan and worst-case cost, then publishes `ding` with an
idempotency key.
