# subetha-core

The Rust core SDK for SubEtha (PLAN §10, track E/F). It implements the v0 protocol in
`spec/README.md`, which is the source of truth, and passes every conformance vector in
`spec/vectors/` byte for byte with the TypeScript reference (`sdk/js/src/protocol`).

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## Modules

| Module | What it does |
|---|---|
| `encoding` | base32 (RFC 4648, lowercase, no padding), base64url (no padding), hex |
| `canonical` | Canonical JSON (spec §3) over `serde_json::Value`. Rejects non-integer or unsafe numbers and non-printable-ASCII keys. Drops object nulls. `canonical_envelope` also drops `sig`/`hops` |
| `topic` | Topic grammar (spec §1.2) and secret topic generation |
| `ulid` | Monotonic ULID generation; reads the timestamp back out |
| `envelope` | Typed `Envelope` (serde), with unknown fields kept in `extra` via `#[serde(flatten)]`. `validate_envelope` mirrors the TS `validateEnvelope`. Also `Transport` and `RouteMode` |
| `sign` | Ed25519 device keys, `dev_` + base32(pubkey) ids, `sign_map`/`verify_map` (spec §4) |
| `e2ee` | XChaCha20-Poly1305 envelope encryption (spec §5) |
| `dedupe` | LRU of seen ids (spec §6); evicts expired entries first; ids are case-insensitive |
| `store` | Store-and-forward outbox: expiry, retries with exponential backoff, idempotent ack, dead letters, persistence hooks |
| `routing` | Delivery plans for `any`/`fast`/`all`/`cheap`, with allow/deny lists, µ$ cost and latency estimates, and worst-case cost caps. Also policy intersection (account ∩ topic ∩ subscription ∩ token ∩ message) |
| `edge::audio` | 16-FSK data-over-sound modem: 48 kHz f32 PCM, preamble, sync, length, CRC-16/CCITT |
| `edge::qr` | Systematic LT fountain code (robust soliton) with a peeling decoder, for animated QR |
| `edge::gossip` | Pure state machine for BLE/LAN gossip (summary → request → deliver). Applies hop limits, dedupe, expiry, interest filtering and signature checks |
| `edge::ble` | GATT service/characteristic UUIDs; MTU-sized chunking and reassembly with CRC |
| `ffi` | JSON/bytes helpers shaped for bindings, exported with the `uniffi` feature (see `BINDINGS.md`) |
| `crc`, `random` | CRC-16/CCITT-FALSE, CRC-32; OS CSPRNG and a deterministic SplitMix64 |

Signing and E2EE work on `serde_json::Map` (`sign_map`, `encrypt_map`, …), so no field can
be lost or reordered. The typed `Envelope` wrappers (`sign_envelope`, `encrypt_envelope`, …)
convert through the map form.

## Differences from the TS reference

- **Device ids must be canonical.** `public_key_from_device_id` rejects an id whose unused
  trailing base32 bits are not zero. Otherwise up to 16 ids could alias one key and slip
  past allow/deny lists keyed on the id string.
- **Signature verification uses `verify_strict`.** It rejects small-order keys and
  non-canonical signatures.
- **Decrypting an envelope that was signed after encryption.** Signing adds `sender` to an
  envelope that is already encrypted, so spec-exact decryption (`decrypt_map`) fails. This is
  a spec gap that the TS reference shares. `decrypt_signed_map` retries without `sender`, and
  the `ffi` decrypt uses it.
- **Integral non-integer literals are accepted.** `canonicalize` accepts `1.0`, `1e2` and
  `-0` as integers. This matches what the TS reference sees after `JSON.parse`.
