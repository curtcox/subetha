/// The SubEtha Rust core for Flutter, through flutter_rust_bridge: envelope signatures and E2EE
/// for `package:subetha` ([CoreDeviceSigner], [CoreEnvelopeCrypto]), and the edge transports
/// (spec §11) with drivers that only need the platform to move bytes and samples ([BleLink],
/// [AudioLink], [QrSender], [QrReceiver], [GossipSession]).
///
/// Call `await SubEthaCore.init()` once before using anything here.
library;

export 'src/core.dart';
export 'src/edge.dart';
export 'src/rust/api/core.dart';
export 'src/rust/api/edge.dart';
