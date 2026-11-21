# subetha-core bindings

PLAN §10 ("SDK architecture") picks one Rust core with generated bindings:

| Target | Tool | Status |
|---|---|---|
| Swift (iOS/macOS), Kotlin (Android/JVM) | [UniFFI](https://mozilla.github.io/uniffi-rs/) proc-macros | `uniffi` feature compiles; bindgen and packaging not wired yet |
| React Native | [uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native) | reuses the UniFFI surface; not wired yet |
| Flutter/Dart | [flutter_rust_bridge](https://github.com/fzyzcjy/flutter_rust_bridge) | planned; reuses the `ffi` functions |
| Web | hand-written TS SDK (`sdk/js`), optional core WASM later | — |

## The `ffi` surface

`src/ffi.rs` holds the exported functions. They only take and return strings, byte vectors,
bools, `Option`, `Vec<String>` and one record, so every generator handles them without
custom type mapping. Envelopes cross the boundary as JSON text.

| Function | Purpose |
|---|---|
| `new_device_key() -> DeviceKeyRecord` | New Ed25519 key: `seed`, `public_key`, `device_id` |
| `device_key_from_seed(seed) -> DeviceKeyRecord` | Rebuild from a stored seed |
| `new_message_id() -> String` | ULID |
| `canonicalize_json(json) -> String` | Spec §3 canonical JSON |
| `validate_envelope_json(json) -> Vec<String>` | Schema problems, empty = valid |
| `sign_envelope_json(json, seed) -> String` | Sets `sender` and `sig` (spec §4) |
| `verify_envelope_json(json) -> bool` | Never throws |
| `encrypt_envelope_json(json, key, kid) -> String` | Spec §5, random nonce |
| `decrypt_envelope_json(json, key) -> Option<String>` | `None` = wrong key or tampered |

Errors map to `FfiError::Failed { msg }`, which becomes a thrown error/exception in each language.

Each function carries `#[cfg_attr(feature = "uniffi", uniffi::export)]`, and `lib.rs` calls
`uniffi::setup_scaffolding!()` when the feature is on. Without the feature, the crate
forbids `unsafe` code, has no UniFFI dependency, and the functions are plain Rust.

```bash
cargo build -p subetha-core --features uniffi   # checks the exported surface
cargo test  -p subetha-core --features uniffi
```

## Next steps

1. **Library artifacts.** Add a thin `sdk/core-ffi` crate (`crate-type = ["cdylib",
   "staticlib"]`) that depends on `subetha-core` with `features = ["uniffi"]`. That keeps
   the core an `rlib` for Rust users and keeps the cdylib link step out of `cargo test`.
2. **Swift/Kotlin.** Use `uniffi-bindgen generate --library target/<triple>/release/libsubetha_core_ffi.{a,so}
   --language swift|kotlin`. Build an XCFramework (aarch64-apple-ios, aarch64-apple-ios-sim,
   x86_64-apple-ios) and an AAR (cargo-ndk: arm64-v8a, armeabi-v7a, x86_64). Publish them as
   a SwiftPM package and a Maven artifact.
3. **React Native.** Point `uniffi-bindgen-react-native` at the same library. It generates a
   Turbo Module (JSI/C++) plus TypeScript. Pin a UniFFI version it supports (0.28 at the time
   of writing).
4. **Flutter.** flutter_rust_bridge v2 generates from plain Rust signatures. Point it at
   `subetha_core::ffi` from a `sdk/core-frb` crate so FRB's attributes and codegen stay out of
   the core.
5. **Stateful objects.** Gossip nodes, outboxes, dedupers and QR decoders hold state. Export
   them as `#[derive(uniffi::Object)]` wrappers around `Mutex<T>` in the FFI crate. Platform
   shims then drive them: BLE/LAN I/O, the audio stream, camera frames, timers.
6. **Conformance.** Each binding's test suite loads `spec/vectors/*.json` through the bound
   functions, as `tests/vectors.rs` does for Rust.
