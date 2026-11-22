import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart' show ExternalLibrary;
import 'package:flutter_test/flutter_test.dart';
import 'package:subetha/subetha.dart';
import 'package:subetha_core/subetha_core.dart';

/// The library cargo builds for the host (`cargo build --manifest-path rust/Cargo.toml`), or
/// SUBETHA_CORE_FRB_LIB.
String libraryPath() {
  final env = Platform.environment['SUBETHA_CORE_FRB_LIB'];
  if (env != null) return env;
  final name = Platform.isMacOS ? 'libsubetha_core_frb.dylib' : Platform.isWindows ? 'subetha_core_frb.dll' : 'libsubetha_core_frb.so';
  return 'rust/target/debug/$name';
}

Map<String, dynamic> vectors(String name) => jsonDecode(File('../../spec/vectors/$name').readAsStringSync()) as Map<String, dynamic>;

List<int> hex(String s) => [for (var i = 0; i < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16)];

void main() {
  setUpAll(() => SubEthaCore.init(library: ExternalLibrary.open(libraryPath())));

  const crypto = CoreEnvelopeCrypto();

  group('conformance vectors', () {
    test('signatures', () async {
      final v = vectors('signatures.json');
      for (final d in v['devices'] as List) {
        expect(CoreDeviceSigner.fromSeed(hex(d['seed'] as String)).deviceId, d['device_id']);
      }
      for (final c in v['cases'] as List) {
        final s = CoreDeviceSigner.fromSeed(hex(c['seed'] as String));
        final signed = jsonDecode(await s.signEnvelope(jsonEncode(c['unsigned']))) as Map;
        expect(signed['sig'], (c['signed'] as Map)['sig']);
        expect(crypto.verify(jsonEncode(c['signed'])), isTrue);
      }
      for (final n in v['negative'] as List) {
        expect(crypto.verify(jsonEncode(n['envelope'])), isFalse, reason: n['name'] as String);
      }
      // The relay-set `event` and edge-decremented `hops` are outside the signature.
      for (final k in ['hops_change', 'event_added']) {
        final e = v[k] as Map;
        expect(crypto.verify(jsonEncode(e['envelope'])), e['valid'], reason: k);
      }
    });

    test('canonical JSON and topics', () {
      final c = vectors('canonical.json');
      for (final o in c['valid'] as List) {
        expect(canonicalizeJson(json: jsonEncode(o['input'])), o['canonical'], reason: o['name'] as String);
      }
      for (final o in c['invalid'] as List) {
        expect(() => canonicalizeJson(json: o['input_json'] as String), throwsA(anything), reason: o['name'] as String);
      }
      final t = vectors('topics.json');
      List<String> problems(String topic) => validateEnvelopeJson(envelopeJson: jsonEncode({'topic': topic}));
      for (final v in t['valid'] as List) {
        expect(problems(v as String), isEmpty, reason: v);
      }
      for (final v in t['invalid'] as List) {
        expect(problems(v as String), isNotEmpty, reason: v);
      }
    });

    test('E2EE', () {
      final v = vectors('e2ee.json');
      final key = hex(v['key'] as String);
      expect(jsonDecode(crypto.decrypt(jsonEncode(v['encrypted']), key)!), v['plaintext']);
      expect(crypto.decrypt(jsonEncode(v['encrypted']), List.filled(32, 0)), isNull);
      final again = crypto.encrypt(jsonEncode(v['plaintext']), key, v['kid'] as String);
      expect(jsonDecode(crypto.decrypt(again, key)!), v['plaintext']);
    });
  });

  test('the core signer matches the pure-Dart one, byte for byte', () async {
    final core = CoreDeviceSigner.generate();
    final dart = await Ed25519DeviceSigner.fromSeed(core.seed);
    expect(core.deviceId, dart.deviceId);
    final msg = utf8.encode('subetha');
    expect(await core.sign(msg), await dart.sign(msg));
    final r = signRequest(seed: core.seed, method: 'POST', host: 'subetha.org', pathAndQuery: '/@me/x', time: BigInt.from(1763750000),
        nonce: 'n' * 22, body: utf8.encode('hi'), headers: const [('X-Title', 'Door')]);
    final d = await RequestSigning.headers(dart, 'POST', Uri.parse('https://subetha.org/@me/x'), utf8.encode('hi'), 1763750000,
        nonce: 'n' * 22, headers: const {'X-Title': 'Door'});
    expect(r.deviceId, core.deviceId);
    expect(r.signedHeaders, d['X-Device-Signed-Headers']);
    expect(r.signature, d['X-Device-Signature']);
    expect(newMessageId(), hasLength(26));
  });

  group('edge drivers', () {
    const topic = '@alice/doorbell';
    int now() => DateTime.now().millisecondsSinceEpoch ~/ 1000;
    String env(String msg, {int hops = 2}) => jsonEncode({'id': newMessageId(), 'time': now(), 'topic': topic, 'message': msg, 'hops': hops});
    String message(String json) => (jsonDecode(json) as Map)['message'] as String;
    GossipNode node() => GossipNode(requireSignatures: false)..subscribe(topic: topic);

    test('BLE links gossip both ways', () {
      final phone = node(), watch = node();
      final atPhone = <String>[], atWatch = <String>[];
      late BleLink phoneLink, watchLink;
      phoneLink = BleLink(phone, write: (c) => watchLink.receive(c), onMessage: atPhone.add, attMtu: 23);
      watchLink = BleLink(watch, write: (c) => phoneLink.receive(c), onMessage: atWatch.add, attMtu: 185);
      expect(phone.publish(envelopeJson: env('ding'), nowSecs: BigInt.from(now())), isTrue);
      expect(watch.publish(envelopeJson: env('dong'), nowSecs: BigInt.from(now())), isTrue);
      phoneLink.resync();
      expect(atWatch.map(message), ['ding']);
      expect(atPhone.map(message), ['dong']);
      watchLink.receive([1, 2, 3]); // dropped, not thrown
      phoneLink.resync();
      expect(atWatch, hasLength(1));
    });

    test('sound round trip at 44.1 kHz', () {
      final n = node();
      final got = <String>[];
      final payload = deliverPayload([env('hi', hops: 1)]);
      final link = AudioLink(44100, play: (_) {}, onPayload: (p) => got.addAll(acceptPayload(n, p)), windowSeconds: payload.length / 40 + 2);
      final all = [...Float32List(22050), ...link.samples(payload), ...Float32List(44100)];
      for (var i = 0; i < all.length; i += 4096) {
        link.onSamples(all.sublist(i, i + 4096 > all.length ? all.length : i + 4096));
      }
      expect(got.map(message), ['hi']);
    });

    test('animated QR, joining late and missing frames', () {
      final n = node();
      final got = <String>[];
      final receiver = QrReceiver((p) => got.addAll(acceptPayload(n, p)));
      final envs = [for (var i = 1; i <= 6; i++) env('message $i with some padding to need several frames')];
      final sender = QrSender(deliverPayload(envs), frameSize: 120);
      expect(sender.sourceBlocks, greaterThan(1));
      expect(receiver.push('https://example.com/not-ours'), isNull);
      var seq = 3;
      while (got.isEmpty && seq < 200) {
        if (seq % 3 != 0) receiver.push(sender.text(seq));
        seq++;
      }
      expect(got.map(message), envs.map(message));
      receiver.push(sender.text(seq)); // same transfer: not delivered again
      expect(got, hasLength(6));
      receiver.push(QrSender(deliverPayload([env('next')])).text(0));
      expect(message(got.last), 'next');
      expect(QrSender.frameSizeFor(535), 356);
    });
  });
}
