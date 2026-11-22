import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart' show ExternalLibrary;
import 'package:subetha/subetha.dart';

import 'rust/api/core.dart' as core;
import 'rust/frb_generated.dart';

/// Loads the core library. Flutter apps call `await SubEthaCore.init()` before anything else
/// here; tests and Dart CLIs pass the library built by cargo (`rust/target/...`).
abstract final class SubEthaCore {
  static bool _ready = false;

  static Future<void> init({ExternalLibrary? library}) async {
    if (_ready) return;
    await RustLib.init(externalLibrary: library);
    _ready = true;
  }
}

/// A device key held by the Rust core. Signs requests, enrollment proofs and envelopes
/// (spec §4) for `package:subetha`. The seed is the secret: keep it in secure storage.
class CoreDeviceSigner extends DeviceSigner {
  final List<int> _seed;
  final List<int> publicKey;
  @override
  final String deviceId;

  CoreDeviceSigner._(core.DeviceKey k)
      : _seed = List.unmodifiable(k.seed),
        publicKey = List.unmodifiable(k.publicKey),
        deviceId = k.deviceId;

  /// Rebuilds a signer from its 32-byte seed.
  factory CoreDeviceSigner.fromSeed(List<int> seed) => CoreDeviceSigner._(core.deviceKeyFromSeed(seed: seed));

  factory CoreDeviceSigner.generate() => CoreDeviceSigner._(core.newDeviceKey());

  List<int> get seed => List.of(_seed);

  @override
  Future<List<int>> sign(List<int> message) async => core.signBytes(seed: _seed, message: message);

  @override
  Future<String> signEnvelope(String envelopeJson) async => core.signEnvelopeJson(envelopeJson: envelopeJson, seed: _seed);
}

/// Signature checks and E2EE (spec §4, §5) for `SubEtha(crypto: ...)`.
class CoreEnvelopeCrypto implements EnvelopeCrypto {
  const CoreEnvelopeCrypto();

  @override
  bool verify(String envelopeJson) => core.verifyEnvelopeJson(envelopeJson: envelopeJson);

  @override
  String encrypt(String envelopeJson, List<int> key, String kid) =>
      core.encryptEnvelopeJson(envelopeJson: envelopeJson, key: key, kid: kid);

  @override
  String? decrypt(String envelopeJson, List<int> key) {
    try {
      return core.decryptEnvelopeJson(envelopeJson: envelopeJson, key: key);
    } catch (_) {
      return null;
    }
  }
}
