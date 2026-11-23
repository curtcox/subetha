"""Poll and subscribe with the Python SDK."""
import os

from subetha import Client

client = Client(os.environ.get("SUBETHA_URL", "https://subetha.us"), token=os.environ["SUBETHA_TOKEN"])

# Cached messages from the last hour, from two topics:
for msg in client.poll(["@me/doorbell", "@me/alarm"], since="1h"):
    print(msg["topic"], msg.get("title"), msg.get("message"))

# A live stream: deduplicated, and it reconnects with since=<last id> after network errors.
for msg in client.subscribe("@me/doorbell"):
    print(msg.get("message"))
    if msg.get("message") == "stop":
        break
