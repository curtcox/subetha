# subetha (Python SDK)

Python SDK for [SubEtha](https://subetha.us), a transport-agnostic, ntfy-compatible pub/sub relay.
It implements the protocol in [`spec/README.md`](../../spec/README.md) and passes every
conformance vector in [`spec/vectors`](../../spec/vectors).

```bash
pip install -e "sdk/python[test]"   # from the repo root
pytest sdk/python
```

## Client

```python
from subetha import Client, SubEthaError

c = Client("https://subetha.us", token="tk_...")
c.publish("@alice/doorbell", "Opened", title="Front door", priority="high", tags=["door"])
c.publish("@alice/doorbell", "Opened", route={"mode": "cheap", "deny": ["sms"]}, dry_run=True)

for msg in c.poll("@alice/doorbell", since="1h"):
    print(msg["id"], msg.get("message"))

for msg in c.subscribe("@alice/doorbell"):   # NDJSON stream, deduped, auto-reconnects with since=<last id>
    print(msg["message"])
```

Errors from the relay raise `SubEthaError` with `code`, `http`, `message`, and the full JSON `body`
(spec §9).

Signed publishing (spec §4):

```python
from subetha import generate_device_key
key = generate_device_key()           # or device_key_from_seed(seed32)
c.publish("@alice/doorbell", "Opened", sign_with=key)
```

An enrolled device can authenticate with signed requests instead of a token (spec §8.1):

```python
device = Client(device_key=key, sign_requests=True)   # X-Device-* headers, no token
```

## Protocol

`subetha.protocol` has canonical JSON, base32/base64url, ULIDs, the topic grammar, envelope
validation, device keys, Ed25519 sign/verify, device-signed requests (`sign_request`), XChaCha20-Poly1305 E2EE (`encrypt_envelope`,
`decrypt_envelope`), wrapped topic keys (`wrap_topic_key`, `unwrap_topic_key`; spec §5.1), and the
`Deduper`. The client's `share_topic_key`, `list_wrapped_keys`, and `load_topic_keys` hand topic keys
to enrolled devices through the relay. Names mirror the TypeScript reference in
`sdk/js/src/protocol` in snake_case.
