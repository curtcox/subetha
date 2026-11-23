# SubEtha protocol spec — v0

This directory is the source of truth for every SubEtha implementation (relay, TypeScript SDK,
Rust core, Python SDK, gateways). If an implementation and this document disagree, the
implementation is wrong.

- `schema/message.schema.json` — JSON Schema (2020-12) for the message envelope.
- `openapi.yaml` — HTTP API (OpenAPI 3.1).
- `vectors/*.json` — conformance test vectors. Every SDK must pass all of them.
- `tools/` — the vector generator and the cross-checker used in CI.

Status: **v0 (draft)**. Breaking changes are allowed until v1, but every change must update the
vectors in the same commit.

---

## 1. Identifiers

### 1.1 Message id
A [ULID](https://github.com/ulid/spec): 26 characters of Crockford base32
(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), the first 10 encoding a 48-bit millisecond timestamp.
Ids are globally unique and are the dedupe key across every transport. Receivers MUST treat ids
case-insensitively and SHOULD normalize to upper case.

### 1.2 Topic names
A topic name is one of:

| Form | Pattern | Example |
|---|---|---|
| Namespaced | `@` handle `/` name | `@alice/doorbell` |
| Secret | `t_` + 26 lowercase base32 chars (128 random bits) | `t_mfrggzdfmztwq2lknnwg23tpoa` |

- handle: `[a-z0-9][a-z0-9-]{0,38}` (lower case, no trailing `-`)
- name: `[A-Za-z0-9_-]{1,64}`
- secret: `t_[a-z2-7]{26}`

Secret topics also match ntfy's topic pattern (`[-_A-Za-z0-9]{1,64}`), so stock ntfy clients can
use them unchanged. Global (un-namespaced) names are **not** accepted in v0 (PLAN open question 6).

### 1.3 Device id
`dev_` followed by the device's 32-byte Ed25519 public key in lowercase RFC 4648 base32 without
padding (52 characters). The public key is recoverable from the id, so any relay, gateway, or
edge peer can verify a signature without a lookup. The last character carries 4 unused bits,
which MUST be zero: verifiers reject non-canonical ids so that each key has exactly one id.
Verifiers SHOULD use strict Ed25519 verification (reject small-order keys and non-canonical
signatures).

## 2. Envelope

See `schema/message.schema.json` for the full field list. It is a superset of the ntfy message
JSON. Rules beyond the schema:

- `id`, `time`, and `event` are set by the relay if the publisher omits them. A **signed**
  message MUST carry `id` and `time` set by the sender.
- `time` and `expires` are Unix seconds (integers).
- `priority` is 1..5; 3 is the default and is omitted on the wire.
- Unknown fields MUST be preserved by relays and edge relays (forward compatibility) and ignored
  by clients that don't understand them.
- Integers only: no field in the envelope may contain a non-integer number. This keeps
  canonicalization trivial across languages.
- All object keys are ASCII.

## 3. Canonical form

The canonical form of an envelope is used for signatures and E2EE associated data. It is the
envelope with the fields `sig`, `hops`, and `event` removed (`event` is set by the relay), serialized as JSON with:

1. object keys sorted by code point (ASCII keys, so byte order == UTF-16 order == RFC 8785 order);
2. no insignificant whitespace;
3. strings escaped minimally: `"` → `\"`, `\` → `\\`, U+0008 → `\b`, U+000C → `\f`,
   U+000A → `\n`, U+000D → `\r`, U+0009 → `\t`, other code points below U+0020 → `\u00xx`
   (lowercase hex); everything else, including non-ASCII, is emitted as raw UTF-8;
4. integers in shortest decimal form (no exponent, no leading zeros, `-0` is `0`);
5. `null` values are removed from objects (an absent field and a null field are the same).

This is a strict subset of [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785).

## 4. Signatures

```
sig = "ed25519:" + base64url_nopad( Ed25519_sign(device_sk, "subetha-sig-v1\n" || canonical(envelope)) )
```

- `sender` MUST be set to the signer's device id, and it is covered by the signature.
- `hops` is excluded so edge relays can decrement it, and `event` because the relay sets it.
- Relays MUST NOT add, remove, or change any other field of a signed or encrypted envelope
  (they track storage expiry separately instead of rewriting `expires`).
- Verifiers derive the public key from `sender` (§1.3).
- A topic policy may require signatures; the relay then rejects unsigned or badly signed
  messages with HTTP 401 `signature_required` / `bad_signature`.

## 5. End-to-end encryption (optional)

Topic keys are 32 random bytes identified by a `kid` string. To encrypt:

1. Collect the *protected* fields that are present: `title`, `message`, `attachment`, `click`,
   `actions`, `content_type`.
2. Serialize them as a canonical JSON object `P`.
3. Remove them from the envelope, then set
   `enc = { "alg": "xchacha20poly1305", "kid": <kid>, "nonce": base64url(24 random bytes) }`.
4. Compute `ct = XChaCha20-Poly1305(key, nonce, plaintext = P, aad = A)` where `A` is the canonical
   form (§3) of the envelope with `enc` set and the fields `message`, `sender`, `sig`, `hops`, and
   `event` removed. (`sender` is excluded because signing, which adds it, happens after encryption.)
5. Set `message = base64url_nopad(ct)`.

Relays route ciphertext and never see keys. Signing happens **after** encryption, so signatures
cover the ciphertext. Decryption restores the protected fields, removes `enc`, and leaves every
other field (including `sender` and `sig`) as received.

### 5.1 Wrapped topic keys

A topic key can be handed to an enrolled device through the relay by sealing it to the device's
identity key. The relay stores and serves wrapped keys but can't open them.

```jsonc
{
  "alg": "x25519-xchacha20poly1305",
  "topic": "@alice/secret",
  "kid": "topic-key-3",          // 1–64 of A–Z a–z 0–9 _ . -
  "to": "dev_…",                 // recipient device id (§1.3)
  "epk": "<base64url, 32 bytes>", // ephemeral X25519 public key
  "nonce": "<base64url, 24 bytes>",
  "ct": "<base64url, 48 bytes>"   // the sealed 32-byte topic key
}
```

To wrap `key` for device `to`:

1. `R` = the Montgomery u-coordinate of `to`'s Ed25519 public key, `u = (1 + y) / (1 − y) mod
   2^255 − 19`, as 32 little-endian bytes. A public key that doesn't decompress to a curve point
   is rejected.
2. Pick a random X25519 secret `e`; `epk = X25519(e, 9)`; `shared = X25519(e, R)`. An all-zero
   `shared` (low-order `R`) is rejected.
3. `k = SHA-256("subetha-wrap-v1\n" ‖ shared ‖ epk ‖ R)`.
4. `ct = XChaCha20-Poly1305(k, nonce, plaintext = key, aad = A)`, where `A` is the canonical
   form (§3) of the object above without `ct`.

To unwrap, the device derives its X25519 secret as the first 32 bytes of `SHA-512(seed)` (the
same expanded secret Ed25519 uses; X25519 clamps it), checks that `to` is its own id, computes
`shared = X25519(secret, epk)` (rejecting all-zero), then `k` and the AEAD as above. Any failure
means the wrapped key is ignored.

## 6. Dedupe

Receivers keep a set of recently seen ids (at least the ids of messages whose `expires` hasn't
passed, bounded by an LRU of at least 10,000 entries). A message whose id is in the set is
dropped silently. A message whose `expires` is in the past is dropped. Ack-by-id is idempotent.

## 7. Hops

`hops` (default 0 = "no edge relaying") is the number of further edge-relay hops allowed. An edge
relay that forwards a message decrements `hops` and MUST NOT forward a message with `hops` ≤ 0.
The relay ignores `hops`.

## 8. HTTP (ntfy-compatible)

| Method | Path | Meaning |
|---|---|---|
| `PUT`/`POST` | `/<topic>` | Publish. Body is the message text (or an attachment with `X-Filename`). |
| `POST` | `/` | Publish a JSON envelope (`{"topic": …, "message": …}`), as in ntfy. |
| `GET` | `/<topic>/json` | Newline-delimited JSON stream (`?poll=1` returns cached messages and closes). |
| `GET` | `/<topic>/sse` | Server-sent events. |
| `GET` | `/<topic>/raw` | Message bodies only, one per line. |
| `GET` | `/<topic>/ws` | WebSocket; each frame is one JSON message. |

`<topic>` is URL-path form: `@alice/doorbell` or `t_…`. Several topics may be subscribed at once
with a comma (`/t_a,t_b/json`), as in ntfy.

Query parameters on subscribe: `since=<id|unix-seconds|duration|all>`, `poll=1`,
`priority=4,5`, `tags=a,b`, `scheduled=0`.

Publish headers (ntfy): `X-Title`/`Title`/`t`, `X-Priority`/`Priority`/`p` (1–5 or
`min|low|default|high|max|urgent`), `X-Tags`/`Tags`/`ta`, `X-Click`, `X-Actions`, `X-Attach`,
`X-Filename`, `X-Delay` (not supported in v0; rejected). Query-string equivalents
(`?title=…`) are accepted too.

SubEtha headers: `X-Route-Mode` (`any|fast|all|cheap`), `X-Max-Cost` (USD, decimal),
`X-Deny`/`X-Allow` (comma-separated transport ids), `X-Deadline` (seconds),
`Idempotency-Key`, `X-Dry-Run: 1`, `X-Sender`, `X-Signature`, `X-Message-Id`, `X-Time`.

Auth: `Authorization: Bearer <token>` (API token or Clerk session JWT), or ntfy-style
`?auth=<base64("Bearer <token>")>`, or HTTP Basic with an empty username and the token as the
password (for ntfy clients).

### 8.1 Device-signed requests

An enrolled device authenticates by signing each request with its Ed25519 key (no bearer
token). It sends:

| Header | Value |
|---|---|
| `X-Device-Id` | `dev_…` (§1.3) |
| `X-Device-Time` | Unix seconds; must be within 300 s of the relay's clock |
| `X-Device-Nonce` | 16–64 base64url characters, single use |
| `X-Device-Signed-Headers` | The signed headers' names: lowercase, comma-separated, no spaces, unique, at most 32. Must include `x-device-id`, `x-device-time` and `x-device-nonce`; must not include `x-device-signature` or `x-device-signed-headers`. |
| `X-Device-Signature` | base64url(Ed25519(signing input)) |

The signing input (`subetha-req-v2`) is these lines joined by `\n`, with no trailing newline:

```
subetha-req-v2
METHOD                  uppercase
host                    WHATWG URL.host: lowercase, ":port" only if not the scheme's default
path?query              URL.pathname + URL.search, percent-encoding as sent
hex(sha256(body))       lowercase hex; the empty body hashes too
name:value              one line per name in X-Device-Signed-Headers, in that order
```

`value` is the header's value with leading and trailing spaces and tabs removed. Every listed
header must be present.

**Covered headers.** The relay rejects (401) a signed request that carries a header from the
covered set without listing it, so a captured request can't be altered in transit. The set:
`Content-Type`, `Content-Encoding`, `Idempotency-Key`, every publish header above with all of
its ntfy aliases (`X-Title`/`Title`/`t`, `X-Priority`/`Priority`/`prio`/`p`,
`X-Tags`/`Tags`/`Tag`/`ta`, `X-Click`/`Click`, `X-Icon`/`Icon`, `X-Attach`/`Attach`/`a`,
`X-Markdown`/`Markdown`/`md`, `X-Actions`/`Actions`/`Action`, `X-Filename`/`Filename`/`File`/`f`,
`X-Message`/`Message`/`m`, `X-Delay`/`Delay`/`X-At`/`At`/`X-In`/`In`), the ntfy names
`X-Email`/`Email`/`e`, `X-Call`/`Call`, `X-Cache`/`Cache`, `X-Firebase`/`Firebase`,
`X-UnifiedPush`/`UnifiedPush`/`up`, `X-Poll-Id`/`Poll-Id`, and the SubEtha headers
`X-Sender`, `X-Signature`, `X-Message-Id`, `X-Time`, `X-Expires`, `X-Route-Mode`, `X-Max-Cost`,
`X-Deny`, `X-Allow`, `X-Deadline`, `X-Dry-Run`. Other headers (`User-Agent`, `Accept`,
`X-Forwarded-For`, …) may be added in transit.

**SDK convention.** SDKs sign `x-device-id`, `x-device-time`, `x-device-nonce`, then every other
header they set, lowercased and sorted by name, skipping `Authorization`, `Host`,
`Content-Length`, `Connection`, `Transfer-Encoding`, `User-Agent`, `Accept` and
`Accept-Encoding` (HTTP stacks set or rewrite these; none is covered). The order doesn't
matter to the relay; the convention makes signatures reproducible (`vectors/requests.json`).

The relay accepts each signature once, and only from an enrolled, unrevoked device. The host is
signed, so a staging signature isn't valid in production.

*Deprecated:* `subetha-req-v1` (no `X-Device-Signed-Headers`) signs
`subetha-req-v1\nMETHOD\nhost\npath?query\ntime\nnonce\nhex(sha256(body))`. The relay still
accepts it for requests that carry no covered header.

## 9. Errors

Every error is JSON:

```json
{ "error": "insufficient_balance", "http": 402, "message": "…", "shortfall_usd_micros": 1234 }
```

Codes are stable and listed in `errors.json`.

## 10. Transport ids

`ws`, `sse`, `poll`, `webpush`, `apns`, `fcm`, `webhook`, `email`, `slack`, `sms`, `voice`,
`mcp`, `lxmf`, `ble`, `audio`, `qr`, `lan`. Edge transports are `ble`, `audio`, `qr`, `lan`.

## 11. Edge framings

Edge transports (§10) run between devices without the relay. Their framings are shared by the
Rust core (`sdk/core/src/edge`) and the TypeScript SDK (`sdk/js/src/edge`) and pinned by
`vectors/edge.json`. Checksums: CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, check value
0x29B1) and CRC-32/IEEE (check value 0xCBF43926). All multi-byte integers are big-endian.
Every framing carries one opaque payload, normally a §11.4 gossip message. One-way links
(audio, QR) carry a single `deliver` message.

### 11.1 Audio (16-FSK)

Mono PCM at 48 kHz. One symbol is 10 ms (480 samples) of one sine tone at amplitude 0.5,
phase restarted at 0 each symbol. Every tone is a multiple of 100 Hz, so the waveform stays
continuous. A frame is:

| Part | Symbols | Tones |
|---|---|---|
| preamble | 8 | alternating 1500 Hz, 5600 Hz (starting with 1500) |
| sync `0x2D 0xD4`, u16 length (≤ 1024), payload, CRC-16 over length‖payload | 2 per byte | high nibble then low nibble; nibble *k* is 2000 + 200·*k* Hz |

The first and last 48 samples get a raised-cosine fade. Receivers search for the preamble,
read the header, and accept a frame only if the sync word and CRC match. Throughput is 50 B/s,
which suits ids, wake-ups, and short messages. Input at other sample rates is resampled to
48 kHz before decoding.

### 11.2 Animated QR (LT fountain code)

The payload is cut into *K* = ⌈len / *B*⌉ blocks of *B* bytes (at least one; the last is
zero-padded) and sent as an endless stream of fixed-size frames:

```
u8 version (1) · u32 payload length · u16 block size B · u32 CRC-32(payload) · u32 seq · B bytes
```

Frame `seq < K` carries block `seq`. A later frame carries the XOR of the blocks chosen like
this: seed SplitMix64 with `seq ^ (crc << 32)` (as u64), draw `u = next_f64()`, take the smallest
degree *d* with `u < CDF[d-1]` from the robust soliton distribution (*c* = 0.1, δ = 0.5, IEEE
double arithmetic, last entry forced to 1), then pick *d* distinct blocks with a partial
Fisher–Yates shuffle of `0..K`: for `i` in `0..d`, swap position `i` with `i + below(K - i)`.
SplitMix64 is the reference generator. `next_f64` is `(x >> 11) / 2^53`, and `below(n)` is
`(x · n) >> 64` on 128-bit integers.

Receivers peel: a frame that reduces to one unknown block solves it, which may unlock others.
The payload is complete when every block is known and the CRC matches. A receiver that joins
late or drops frames just keeps scanning. It typically needs about 1.1–1.5·*K* frames.

Each frame is shown as one QR code holding the frame as **base45** text (RFC 9285) in
alphanumeric mode, which is about 97% efficient versus 75% for base64. Binary byte-mode QR
codes are also allowed where the scanner returns raw bytes.

### 11.3 Bluetooth LE

One GATT service, `53554245-5448-4100-8000-5ebe7a000000`. The first 7 bytes spell `SUBETHA`.

| Characteristic | UUID suffix | Properties | Carries |
|---|---|---|---|
| inbox | `…0001` | write, write without response | chunks from the central |
| outbox | `…0002` | notify, indicate | chunks to the central |
| summary | `…0003` | read | a §11.4 summary, for quick peeks |
| version | `…0004` | read | `[1]` |

Each message is `payload ‖ CRC-16(payload)`, split into chunks of at most `ATT_MTU − 9` bytes,
each prefixed with `u16 seq · u16 index · u16 count`. Chunks may arrive out of order or more than once.
Messages are keyed by `seq`, and a receiver drops partial messages after a timeout.

### 11.4 Gossip (BLE, LAN)

Peers exchange JSON messages tagged by `type`:

```json
{"type":"summary","topics":{"@alice/doorbell":["01JD…","01JD…"]}}
{"type":"request","ids":["01JD…"]}
{"type":"deliver","envelopes":[{ "id":"01JD…", "topic":"@alice/doorbell", "hops":1, … }]}
```

When peers meet, each sends a summary: for every topic, the most recent ids it can forward
(hops > 0, not expired). The other side requests the ids it hasn't seen on topics it subscribes
to or relays. The holder delivers them with `hops` decremented. Receivers drop envelopes with
no id, on topics they don't want, with `hops` outside 0..16, expired, already seen (§6), or with a
signature that doesn't verify (§4). Nodes may also require signatures. Signatures exclude
`hops` and E2EE (§5) hides content, so relaying nodes can neither forge nor read messages.

### 11.5 LAN

Peers multicast a beacon to `239.255.83.69:47353` (UDP, TTL 1) every few seconds:

```json
{"subetha":"lan/1","node":"0123456789abcdef","port":51234}
```

`node` is 16 random lowercase hex characters per process, and `port` is the peer's unicast UDP
port. A node ignores its own beacons and forgets peers it hasn't heard from in 30 s. On hearing a
new peer, or receiving a unicast datagram from an unknown address, a node sends that peer its
summary (§11.4). Gossip messages travel peer to peer over unicast UDP, split into datagrams with
the §11.3 chunk framing at 1200 data bytes each (`ATT_MTU` = 1209 in §11.3 terms). Receivers
reassemble each peer's datagrams separately.
