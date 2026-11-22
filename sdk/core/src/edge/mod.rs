//! Edge transports: pure protocol logic for links that work without the relay.
//! Platform shims provide the radios, speakers, microphones and cameras.
//!
//! - [`audio`]: 16-FSK data-over-sound modem (48 kHz PCM in/out).
//! - [`qr`]: LT fountain-coded frames for animated QR.
//! - [`gossip`]: summary/request/deliver gossip for BLE and LAN, with hop limits.
//! - [`ble`]: GATT UUIDs and MTU-sized chunking/reassembly.
//! - [`lan`]: multicast beacons and datagram framing for LAN gossip.

pub mod audio;
pub mod ble;
pub mod gossip;
pub mod lan;
pub mod qr;
