//! UniFFI's bindgen CLI, built from the same `uniffi` version as the library so the generated
//! Kotlin/Swift always match the scaffolding. See `scripts/gen-bindings.sh` and `BINDINGS.md`.

fn main() {
    uniffi::uniffi_bindgen_main()
}
