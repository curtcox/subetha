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

The owner's side, and direct enrollment when the device can hand you its id and a fresh proof
(the same `enrollmentProof` output; device ids are public, so the id alone isn't enough):

<!-- include: samples/curl/device-flow.sh -->

In the console, paste that JSON into **Devices → Enroll with a proof** within 5 minutes of making it.

## Signed requests

Every request from an enrolled device carries:

```http
X-Device-Id: dev_kxisxbay4mtidk6z454fh3jcjhf3wfpggcprvnuu42wa2fvbeiwa
X-Device-Time: 1763750000
X-Device-Nonce: 9f2Kx_Lq0aZ7mW3vB8cR1g
X-Device-Signed-Headers: x-device-id,x-device-time,x-device-nonce,content-type,x-priority,x-title
X-Device-Signature: <base64url Ed25519 signature>
```

The signature covers `"subetha-req-v2\n" + METHOD + "\n" + host + "\n" + path?query + "\n" +
hex(sha256(body))`, followed by `"\n" + name + ":" + value` for each header named in
`X-Device-Signed-Headers`, in that order ([spec §8.1](https://github.com/curtcox/subetha/blob/main/spec/README.md#81-device-signed-requests)).

- `X-Device-Time` must be within 5 minutes of the relay's clock, and the nonce is 16–64 random
  base64url characters. Each signature is accepted once; a replay gets `401`.
- Headers that change what a request does must be signed: `Content-Type`, `Idempotency-Key`,
  every ntfy publish header and its aliases (`X-Title`, `Title`, `t`, …), and the routing and
  cost headers (`X-Route-Mode`, `X-Max-Cost`, `X-Allow`, `X-Deny`, `X-Dry-Run`, …). If one is
  present but not signed, the request gets `401`, so nobody relaying a captured request can
  change its content, route, or cost. Other headers (`User-Agent`, proxy headers) can be added
  in transit.
- The host is signed, so a signature made for staging isn't valid in production.

Every SDK does this for you: `new SubEtha({ deviceKey, signRequests: true })` in TypeScript,
`Client(device_key=key, sign_requests=True)` in Python (or `httpx.Client(auth=DeviceAuth(key))`),
the device signer in the Kotlin, Swift, and Dart SDKs, and `createClient({ core, deviceSeed, signRequests: true })` in React Native (signing with the Rust core). The shared test vectors are in
`spec/vectors/requests.json`.

The older `subetha-req-v1` form, without `X-Device-Signed-Headers`, is still accepted for
requests that carry none of those headers. It's deprecated.

## Keys

Generate the key on the device and never move it: `generateDeviceKey()` (TypeScript),
`generate_device_key()` (Python), or `DeviceKey::generate()` (Rust). Persist the 32-byte seed in
the platform's secure storage (Keychain, Android Keystore, a file readable only by the service
user) and restore it with `deviceKeyFromSeed` / `device_key_from_seed` / `DeviceKey::from_seed`. A lost key means enrolling again; a leaked key
means revoking the device.

> devicebasedauth.org integration (PLAN open question 1) may replace or extend this flow. The
> request-signature format will stay.
