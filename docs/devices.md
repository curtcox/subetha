# Devices

A **device** is anything with its own Ed25519 key: a phone app, a browser, a Raspberry Pi, a CLI,
an ESP32 bridge, an agent. Its id is `dev_` followed by its public key in base32, so anyone can
verify its signatures without a lookup.

An enrolled device:

- authenticates by **signing each request** with its key, so no bearer token has to be stored on it;
- can **publish and subscribe** (subject to topic policies) but can't manage the account (tokens,
  billing, endpoints);
- can be listed and **revoked** at any time;
- costs a little rent per day while enrolled ([Pricing](pricing.md)).

Devices can also sign *messages* (independently of enrollment) so receivers know who sent them:
see [Signed messages](publishing.md#signed-messages).

## Enrolling with the device flow

For devices with a screen or a log but no browser, an RFC 8628-style flow: the device shows a
short code, you approve it in the console, the device is enrolled.

<!-- include: samples/ts/devices.ts#snippet -->

1. **`POST /v1/device/code`** (no credentials). The device sends its id, the current time, and a
   proof: an Ed25519 signature over `"subetha-enroll-v1\n" + device_id + "\n" + time`
   (`enrollmentProof(key)` in the SDK). It gets a `user_code` like `BCDF-GHJK`, valid for 10
   minutes, and a `device_code` to poll with.
2. **`POST /v1/device/approve`** by the owner: open `verification_uri_complete` (the console's **Devices** tab with the code filled in) and press Approve, or call it with an admin token.
3. **`POST /v1/device/token`** by the device, every `interval` seconds, until it stops answering
   `{"error": "authorization_pending"}`.

The owner's side, and direct enrollment when you already know a device's id:

<!-- include: samples/curl/device-flow.sh -->

## Signed requests

Every request from an enrolled device carries:

```http
X-Device-Id: dev_kxisxbay4mtidk6z454fh3jcjhf3wfpggcprvnuu42wa2fvbeiwa
X-Device-Time: 1763750000
X-Device-Nonce: 9f2Kx_Lq0aZ7mW3vB8cR1g
X-Device-Signature: <base64url Ed25519 signature>
```

The signature covers `"subetha-req-v1\n" + METHOD + "\n" + host + "\n" + path?query + "\n" +
time + "\n" + nonce + "\n" + hex(sha256(body))`. `X-Device-Time` must be within 5 minutes of the
relay's clock, the nonce is 16–64 random base64url characters, and each signature is accepted
once (a replay is `401`). Including the host means a signature made for staging isn't valid in
production. The TypeScript SDK does all of this with
`new SubEtha({ deviceKey, signRequests: true })`.

## Keys

Generate the key on the device and never move it: `generateDeviceKey()` (TypeScript),
`generate_device_key()` (Python), or `DeviceKey::generate()` (Rust). Persist the 32-byte seed in
the platform's secure storage (Keychain, Android Keystore, a file readable only by the service
user) and restore it with `deviceKeyFromSeed` / `device_key_from_seed` / `DeviceKey::from_seed`. A lost key means enrolling again; a leaked key
means revoking the device.

> devicebasedauth.org integration (PLAN open question 1) may replace or extend this flow. The
> request-signature format will stay.
