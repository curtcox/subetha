"""Signed publishing and E2EE primitives in Python."""
import os

from subetha import Client, decrypt_envelope, device_key_from_seed, encrypt_envelope, generate_device_key, verify_envelope

client = Client(os.environ.get("SUBETHA_URL", "https://subetha.us"), token=os.environ["SUBETHA_TOKEN"])

# A device key. Persist key.seed (32 bytes) and restore it with device_key_from_seed(seed).
key = generate_device_key()
assert device_key_from_seed(key.seed).device_id == key.device_id

sent = client.publish("@me/sensors", "Temperature 21.5C", sign_with=key)
print(sent["sender"], verify_envelope(sent))

# E2EE: encrypt locally with a 32-byte topic key shared out of band; the relay sees ciphertext.
topic_key = os.urandom(32)
sealed = encrypt_envelope({"topic": "@me/secrets", "title": "Door code", "message": "4721"}, topic_key, "k1")
print(sealed["enc"], decrypt_envelope(sealed, topic_key)["message"])
