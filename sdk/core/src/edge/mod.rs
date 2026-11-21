//! Edge transports: pure protocol logic for links that work without the relay.
//! Platform shims provide the radios, speakers, microphones and cameras.
//!
//! - [`audio`]: 16-FSK data-over-sound modem (48 kHz PCM in/out).
//! - [`qr`]: LT fountain-coded frames for animated QR.
//! - [`gossip`]: summary/request/deliver gossip for BLE and LAN, with hop limits.
//! - [`ble`]: GATT UUIDs and MTU-sized chunking/reassembly.

pub mod audio;
pub mod ble;
pub mod gossip;
pub mod qr;
