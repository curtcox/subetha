//! Sign, encrypt, verify, and dedupe envelopes with the Rust core (`subetha-core`).
//! Built and run by `cargo test` / `cargo run -p subetha-core --example sign_and_encrypt`.
use subetha_core::e2ee::generate_topic_key;
use subetha_core::{decrypt_envelope, encrypt_envelope, sign_envelope, verify_envelope, Deduper, DeviceKey, Envelope};

fn main() -> Result<(), subetha_core::Error> {
    // A device identity. Persist key.seed() and restore it with DeviceKey::from_seed(&seed).
    let key = DeviceKey::generate();
    println!("device id: {}", key.device_id());

    let mut env = Envelope::new("@me/sensors", "Temperature 21.5C").with_id_and_time();
    env.title = Some("Garage".into());

    // Encrypt first (the relay will only see ciphertext), then sign the ciphertext.
    let topic_key = generate_topic_key();
    let sealed = encrypt_envelope(&env, &topic_key, "k1")?;
    let signed = sign_envelope(&sealed, &key)?;
    assert!(verify_envelope(&signed));
    println!("{}", serde_json::to_string(&signed).expect("json"));

    // A receiver: drop duplicates (the same id can arrive over BLE and WebSocket), then decrypt.
    let mut seen = Deduper::new(10_000);
    let now = signed.time.unwrap_or_default() as u64;
    assert!(seen.accept_envelope(&signed, now));
    assert!(!seen.accept_envelope(&signed, now));
    let plain = decrypt_envelope(&signed, &topic_key).expect("right key");
    assert_eq!(plain.message.as_deref(), Some("Temperature 21.5C"));
    Ok(())
}
