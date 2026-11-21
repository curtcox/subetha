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
envelope with the fields `sig` and `hops` removed, serialized as JSON with:

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
- `hops` is excluded so edge relays can decrement it.
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
   form (§3) of the envelope with `enc` set and the fields `message`, `sender`, `sig`, and `hops`
   removed. (`sender` is excluded because signing, which adds it, happens after encryption.)
5. Set `message = base64url_nopad(ct)`.

Relays route ciphertext and never see keys. Signing happens **after** encryption, so signatures
cover the ciphertext. Decryption restores the protected fields, removes `enc`, and leaves every
other field (including `sender` and `sig`) as received.

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

## 9. Errors

Every error is JSON:

```json
{ "error": "insufficient_balance", "http": 402, "message": "…", "shortfall_usd_micros": 1234 }
```

Codes are stable and listed in `errors.json`.

## 10. Transport ids

`ws`, `sse`, `poll`, `webpush`, `apns`, `fcm`, `webhook`, `email`, `slack`, `sms`, `voice`,
`mcp`, `lxmf`, `ble`, `audio`, `qr`, `lan`. Edge transports are `ble`, `audio`, `qr`, `lan`.
