"""A minimal bring-your-own gateway: bridge a topic to any local transport.

Anything that can subscribe and publish over the public API is a gateway. This one bridges a
topic to lines on a serial port (a LoRa modem, an Arduino…). Replace send_local/read_local with
your transport. gateways/reticulum is a complete example of the same pattern.
"""
import os
import threading

from subetha import Client

TOPIC = os.environ.get("TOPIC", "@me/mesh")
client = Client(os.environ.get("SUBETHA_URL", "https://subetha.org"), token=os.environ["SUBETHA_TOKEN"])
seen: set[str] = set()  # ids we published, so we don't echo them back


def send_local(text: str) -> None:
    print(f"-> local: {text}")  # e.g. serial.write(text.encode() + b"\n")


def read_local():
    while True:  # e.g. yield serial.readline().decode().strip()
        yield input()


def relay_to_local() -> None:
    for msg in client.subscribe(TOPIC):  # reconnects and resumes from the last id
        if msg["id"] in seen:
            continue
        send_local(msg.get("message", ""))


def local_to_relay() -> None:
    for line in read_local():
        if line:
            sent = client.publish(TOPIC, line, tags=["gateway"], route={"deny": ["sms", "voice"]})
            seen.add(sent["id"])


threading.Thread(target=relay_to_local, daemon=True).start()
local_to_relay()
