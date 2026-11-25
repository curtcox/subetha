# Devices

A **device** is a phone app, a browser, a Raspberry Pi, a CLI, an ESP32 bridge, an agent: anything
that holds its own key. Devices enroll at **[devicebasedauth.org](https://devicebasedauth.org)**
(DBA): the key is made on the device and never leaves it, you approve the device there and choose
what it may do, and you can revoke it there or here. subetha checks each request's DBA credential
itself (offline: the issuer's signature, its revocation list, and a fresh proof of the device's key).

A device:

- authenticates with its **DBA credential and a proof of its key** on each request, so no bearer
  token is stored on it;
- can **publish and subscribe** within its grants (subject to topic policies), but can't manage the
  account (tokens, billing, endpoints);
- can be listed, **paused**, limited to some transports, and **revoked** at any time, here or at
  devicebasedauth.org;
- costs a little rent per day while enrolled ([Pricing](pricing.md)).

Devices can also sign *messages* so receivers know who sent them: see
[Signed messages](publishing.md#signed-messages).

## Enrolling a device

1. **Link devicebasedauth.org once.** In the console, **Devices → Link devicebasedauth.org** signs
   you in there and links that account to this one (`POST /v1/dba/link/start`, then `/finish`).
   One devicebasedauth.org account links to one subetha account.
2. **Enroll the device at devicebasedauth.org** for the audience `subetha.us`, with grants for
   `subetha:publish` and `subetha:subscribe`. Resources limit them to topics: a topic name
   (`@me/doorbell`) or a prefix (`@me/*`); none means every topic. You approve it there.
   - CLI or server: `dba enroll --aud subetha.us --action subetha:publish --action subetha:subscribe --resource "@me/*"`,
     then `dba curl …` (or `dba headers METHOD URL` for any HTTP client).
   - Browser: `const dba = new DBA()` from `https://devicebasedauth.org/sdk/v1.4.0/dba.js`, then
     `dba.enroll({ aud: ["subetha.us"], grants: [{ actions: ["subetha:publish", "subetha:subscribe"] }] })`;
     pass it to the SDK as `new SubEtha({ dba })`.
   - Android and iOS: devicebasedauth.org's Keystore and Secure Enclave samples.
3. **Use it.** Requests carry `Authorization: DBA <credential>` and `DPoP: <proof>`. The device
   shows up under **Devices** as `dba:<id>` on first use.

<!-- include: samples/ts/devices.ts#snippet -->

<!-- include: samples/curl/devices-dba.sh -->

### Signing keys (E2EE and signed messages)

E2EE topic keys are sealed to an Ed25519 key, and signed messages are signed by one. A DBA device
attaches such a key with **`POST /v1/devices/dba`**, proving it holds it with
`enrollmentProof(key)` (an Ed25519 signature over `"subetha-enroll-v1\n" + device_id + "\n" + time`).
The device needs grants on every topic for this. The key, `dev_` followed by its public key in
base32, is then listed beside its DBA device and signs requests as below; revoking the DBA
credential stops it too. `attachDeviceKey(key)` in the TypeScript SDK does this, and so does
**Devices → This browser → Enroll this browser** in the console and bare `subetha login` in the
CLI (through the `dba` CLI).

subetha's own device-code flow (`/v1/device/code`, `/approve`, `/token`) and direct registration
(`POST /v1/devices`) are retired and answer `410`.

## Signed requests

Every request signed with an attached key carries:

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
user) and restore it with `deviceKeyFromSeed` / `device_key_from_seed` / `DeviceKey::from_seed`. A lost key means attaching a new one; a leaked key
means revoking the device (or its devicebasedauth.org credential).
