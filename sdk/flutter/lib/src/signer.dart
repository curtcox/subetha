import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';

/// An Ed25519 device key (spec §1.3): signs HTTP requests (`X-Device-*`), enrollment proofs
/// and, with the Rust core, envelopes.
abstract class DeviceSigner {
  /// `dev_` + base32(public key).
  String get deviceId;

  /// Raw 64-byte Ed25519 signature.
  Future<List<int>> sign(List<int> message);

  /// Signs an envelope (spec §4: canonical JSON; sets `sender` and `sig`). Needs the Rust
  /// core (flutter_rust_bridge binding; see README).
  Future<String> signEnvelope(String envelopeJson) async =>
      throw UnsupportedError('envelope signing needs the SubEtha core binding');
}

/// Signature checks and E2EE (spec §4, §5), provided by the Rust core binding.
abstract class EnvelopeCrypto {
  bool verify(String envelopeJson);
  String encrypt(String envelopeJson, List<int> key, String kid);

  /// `null` if the key is wrong or the message was tampered with.
  String? decrypt(String envelopeJson, List<int> key);
}

/// Pure-Dart Ed25519 (package:cryptography). Deterministic (RFC 8032), so signatures are
/// byte-identical to the Rust core's.
class Ed25519DeviceSigner extends DeviceSigner {
  static final _algo = Ed25519();
  final SimpleKeyPair _keyPair;
  final List<int> publicKey;
  final List<int> seed;
  @override
  final String deviceId;

  Ed25519DeviceSigner._(this._keyPair, this.seed, this.publicKey) : deviceId = Encoding.deviceId(publicKey);

  /// Rebuilds a signer from its 32-byte seed (keep it in secure storage).
  static Future<Ed25519DeviceSigner> fromSeed(List<int> seed) async {
    if (seed.length != 32) throw ArgumentError('Ed25519 seeds are 32 bytes');
    final kp = await _algo.newKeyPairFromSeed(seed);
    final pub = await kp.extractPublicKey();
    return Ed25519DeviceSigner._(kp, List.unmodifiable(seed), List.unmodifiable(pub.bytes));
  }

  static Future<Ed25519DeviceSigner> generate() {
    final r = Random.secure();
    return fromSeed(List<int>.generate(32, (_) => r.nextInt(256)));
  }

  @override
  Future<List<int>> sign(List<int> message) async => (await _algo.sign(message, keyPair: _keyPair)).bytes;

  /// Verifies a raw signature by [publicKey] (for tests and tools).
  static Future<bool> verify(List<int> message, List<int> signature, List<int> publicKey) => _algo.verify(
        message,
        signature: Signature(signature, publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519)),
      );
}

/// Device-signed requests and enrollment proofs (see workers/api/src/devices.ts).
class RequestSigning {
  RequestSigning._();

  /// `URL.host` as WHATWG defines it: lowercase host, plus `:port` unless it is the default.
  static String host(Uri u) {
    var h = u.host.toLowerCase();
    if (h.contains(':')) h = '[$h]'; // IPv6
    return u.hasPort && u.port != _defaultPort(u.scheme) ? '$h:${u.port}' : h;
  }

  static int? _defaultPort(String scheme) => const {'http': 80, 'ws': 80, 'https': 443, 'wss': 443}[scheme.toLowerCase()];

  /// A fresh single-use nonce: base64url of 16 random bytes.
  static String newNonce() {
    final r = Random.secure();
    return Encoding.base64url(List<int>.generate(16, (_) => r.nextInt(256)));
  }

  /// Headers the SDKs don't sign (spec §8.1): credentials, and headers HTTP stacks set or rewrite.
  static const unsignedByConvention = {
    'authorization', 'host', 'content-length', 'connection', 'transfer-encoding', 'user-agent', 'accept', 'accept-encoding',
  };

  /// The signing input (spec §8.1, `subetha-req-v2`):
  /// `subetha-req-v2\nMETHOD\nhost\npath?query\nhex(sha256(body))`, then `\nname:value` for each
  /// of [signedHeaders] in order (values trimmed of spaces and tabs).
  static Future<String> input(String method, Uri url, List<int> body, List<(String, String)> signedHeaders) async {
    final path = url.path.isEmpty ? '/' : url.path;
    final query = url.hasQuery ? '?${url.query}' : '';
    final digest = Encoding.hex((await Sha256().hash(body)).bytes);
    final sb = StringBuffer('subetha-req-v2\n${method.toUpperCase()}\n${host(url)}\n$path$query\n$digest');
    for (final (name, value) in signedHeaders) {
      sb.write('\n${name.toLowerCase()}:${value.replaceAll(RegExp(r'^[ \t]+|[ \t]+$'), '')}');
    }
    return sb.toString();
  }

  /// The SDK convention for what to sign: X-Device-Id, -Time, -Nonce, then every other header
  /// the request carries, lowercased and sorted, except [unsignedByConvention] and `x-device-*`.
  static List<(String, String)> headersToSign(String deviceId, int time, String nonce, Map<String, String> headers) {
    final rest = <String, String>{};
    headers.forEach((k, v) {
      final n = k.toLowerCase();
      if (unsignedByConvention.contains(n) || n.startsWith('x-device-')) return;
      rest[n] = v;
    });
    final names = rest.keys.toList()..sort();
    return [('x-device-id', deviceId), ('x-device-time', '$time'), ('x-device-nonce', nonce), for (final n in names) (n, rest[n]!)];
  }

  /// `X-Device-Id`, `X-Device-Time`, `X-Device-Nonce`, `X-Device-Signed-Headers`,
  /// `X-Device-Signature`. [headers] are the headers the request will carry (content and
  /// routing headers must be signed). Relays accept each nonce once, so every request (and
  /// retry) is signed afresh.
  static Future<Map<String, String>> headers(DeviceSigner signer, String method, Uri url, List<int> body, int time,
      {String? nonce, Map<String, String> headers = const {}}) async {
    final n = nonce ?? newNonce();
    if (!RegExp(r'^[A-Za-z0-9_-]{16,64}$').hasMatch(n)) throw ArgumentError('nonce must be 16-64 base64url characters');
    final signed = headersToSign(signer.deviceId, time, n, headers);
    if (signed.length > 32) throw ArgumentError('at most 32 signed headers');
    final sig = await signer.sign(utf8.encode(await input(method, url, body, signed)));
    return {
      'X-Device-Id': signer.deviceId,
      'X-Device-Time': '$time',
      'X-Device-Nonce': n,
      'X-Device-Signed-Headers': signed.map((h) => h.$1).join(','),
      'X-Device-Signature': Encoding.base64url(sig),
    };
  }

  /// Proof of key possession for `POST /v1/devices/dba`.
  static Future<({String deviceId, int time, String proof})> enrollmentProof(DeviceSigner signer, int time) async {
    final sig = await signer.sign(utf8.encode('subetha-enroll-v1\n${signer.deviceId}\n$time'));
    return (deviceId: signer.deviceId, time: time, proof: Encoding.base64url(sig));
  }
}

/// Encodings used by the protocol (spec §1).
class Encoding {
  Encoding._();
  static const _b32 = 'abcdefghijklmnopqrstuvwxyz234567';

  /// RFC 4648 base32, lowercase, no padding.
  static String base32(List<int> bytes) {
    final out = StringBuffer();
    var buffer = 0;
    var bits = 0;
    for (final b in bytes) {
      buffer = ((buffer << 8) | (b & 0xff)) & 0xffff;
      bits += 8;
      while (bits >= 5) {
        out.write(_b32[(buffer >> (bits - 5)) & 31]);
        bits -= 5;
      }
    }
    if (bits > 0) out.write(_b32[(buffer << (5 - bits)) & 31]);
    return out.toString();
  }

  static String base64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

  static List<int> base64urlDecode(String s) => base64Url.decode(base64Url.normalize(s));

  static String hex(List<int> bytes) => bytes.map((b) => (b & 0xff).toRadixString(16).padLeft(2, '0')).join();

  static List<int> hexDecode(String s) =>
      List<int>.generate(s.length ~/ 2, (i) => int.parse(s.substring(i * 2, i * 2 + 2), radix: 16));

  static String deviceId(List<int> publicKey) => 'dev_${base32(publicKey)}';
}

/// ULIDs (spec §1.1): 48-bit millisecond time + 80 random bits, Crockford base32.
class Ulid {
  Ulid._();
  static const _crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  static final _random = Random.secure();

  static String next([DateTime? now]) {
    var t = (now ?? DateTime.now()).millisecondsSinceEpoch;
    final out = List<String>.filled(26, '0');
    for (var i = 9; i >= 0; i--) {
      out[i] = _crockford[t & 31];
      t >>= 5;
    }
    for (var i = 10; i < 26; i++) {
      out[i] = _crockford[_random.nextInt(32)];
    }
    return out.join();
  }
}
