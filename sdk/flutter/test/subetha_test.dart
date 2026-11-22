import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:subetha/subetha.dart';
import 'package:test/test.dart';

// RFC 8032 test 1 seed; spec/vectors/signatures.json devices[0].
const seedHex = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const deviceId = 'dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena';
// spec/vectors/requests.json nonce; enrollSig is pinned in sdk/core/src/ffi.rs.
const nonce = 'nonce_0123456789abcdef';
const enrollSig = 'ZTDaaJXLPfCowo3I7bl8k3JvIl5nYldqr4735NNFrw4bGcu-Tl2p2W7jYXZH8NuORBcsaVO-5Em3aahKD1eqDQ';

class Recorded {
  final http.BaseRequest request;
  final String body;
  Recorded(this.request, this.body);
  String get pathAndQuery => request.url.path + (request.url.hasQuery ? '?${request.url.query}' : '');
  Map<String, dynamic> get json => jsonDecode(body) as Map<String, dynamic>;
}

/// A mock relay. [handler] returns the response; `lines` builds an NDJSON stream that, with
/// `hold`, stays open until the client cancels.
class Relay {
  final requests = <Recorded>[];
  late final MockClient client;

  Relay(FutureOr<http.StreamedResponse> Function(Recorded r, int n) handler) {
    client = MockClient.streaming((request, bodyStream) async {
      final r = Recorded(request, await bodyStream.bytesToString());
      requests.add(r);
      return handler(r, requests.length);
    });
  }

  static http.StreamedResponse json(String body, {int status = 200, Map<String, String> headers = const {}}) =>
      http.StreamedResponse(Stream.value(utf8.encode(body)), status, headers: headers);

  static http.StreamedResponse lines(List<String> lines, {bool hold = false}) {
    final c = StreamController<List<int>>();
    for (final l in lines) {
      c.add(utf8.encode('$l\n'));
    }
    if (!hold) c.close();
    return http.StreamedResponse(c.stream, 200);
  }
}

void main() {
  test('publish sends JSON with auth, idempotency key and route', () async {
    final relay = Relay((r, _) => Relay.json(r.body));
    final c = SubEtha(baseUrl: 'https://x.test/', token: 'se_t', httpClient: relay.client);
    final m = await c.publish(
        '@a/b',
        'hi',
        const PublishOptions(
            title: 'T', priority: 3, tags: ['x'], route: Route(mode: RouteMode.fast, maxCostUsd: 0.02, deny: ['sms']), idempotencyKey: 'k'));
    final r = relay.requests.single;
    expect(r.request.method, 'POST');
    expect(r.request.url.toString(), 'https://x.test/');
    expect(r.request.headers['Authorization'], 'Bearer se_t');
    expect(r.request.headers['Idempotency-Key'], 'k');
    expect(r.json, {
      'topic': '@a/b',
      'message': 'hi',
      'title': 'T',
      'tags': ['x'],
      'route': {
        'mode': 'fast',
        'max_cost_usd_micros': 20000,
        'deny': ['sms']
      },
    });
    expect(m.message, 'hi');
    expect(m.priority, 3);
  });

  test('estimate sends X-Dry-Run', () async {
    final relay = Relay((r, _) => Relay.json(
        '{"dry_run":true,"estimate_usd_micros":1500,"plan":[{"transport":"ws"},{"transport":"sms"}],"message":${r.body}}'));
    final e = await SubEtha(httpClient: relay.client).estimate('@a/b', 'ding', const PublishOptions(route: Route(mode: RouteMode.all)));
    expect(relay.requests.single.request.headers['X-Dry-Run'], '1');
    expect(e.estimateUsdMicros, 1500);
    expect(e.estimateUsd, 0.0015);
    expect(e.plan.map((p) => p['transport']), ['ws', 'sms']);
    expect(e.message?.message, 'ding');
  });

  test('errors carry code, status, body and Retry-After', () async {
    final relay = Relay((_, __) => Relay.json(
        '{"error":"insufficient_balance","http":402,"message":"no money","shortfall_usd_micros":5}',
        status: 402,
        headers: {'retry-after': '7'}));
    final e = await SubEtha(httpClient: relay.client).publish('@a/b', 'x').then<Object>((_) => 'no error', onError: (Object e) => e);
    expect(e, isA<SubEthaException>());
    final s = e as SubEthaException;
    expect(s.code, 'insufficient_balance');
    expect(s.status, 402);
    expect(s.body['shortfall_usd_micros'], 5);
    expect(s.retryAfter, 7);
    expect(s.retryable, isFalse);

    final relay2 = Relay((_, __) => Relay.json('upstream down', status: 503));
    await expectLater(
        SubEtha(httpClient: relay2.client).balance(),
        throwsA(isA<SubEthaException>()
            .having((e) => e.code, 'code', 'provider_unavailable')
            .having((e) => e.message, 'message', 'upstream down')
            .having((e) => e.retryable, 'retryable', isTrue)));
  });

  test('poll parses NDJSON and encodes topics', () async {
    final relay = Relay((_, __) => Relay.lines(['{"id":"01A","topic":"@a/b c","message":"one"}', '{"id":"01B","topic":"@a/b c","message":"two"}']));
    final got = await SubEtha(httpClient: relay.client).poll(['@a/b c', '@a/d'], priority: [4, 5]);
    expect(got.map((m) => m.message), ['one', 'two']);
    expect(relay.requests.single.request.url.toString(), 'https://subetha.org/@a/b%20c,@a/d/json?poll=1&since=all&priority=4,5');
  });

  test('subscribe dedupes, resumes from the last id, and acks', () async {
    var opens = 0;
    final relay = Relay((r, _) {
      if (r.request.url.path == '/v1/ack') return Relay.json('{"acked":true}');
      if (!r.request.url.hasQuery) {
        return Relay.lines([
          '{"event":"open"}',
          '{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one","event":"message"}',
          '{"id":"01jd0000000000000000000001","topic":"@a/b","message":"one"}',
          '{"event":"keepalive"}',
        ]);
      }
      return Relay.lines([
        '{"event":"open"}',
        '{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one"}',
        '{"id":"01JD0000000000000000000002","topic":"@a/b","message":"two"}',
      ], hold: true);
    });
    final c = SubEtha(baseUrl: 'https://x.test', token: 'se_t', httpClient: relay.client);
    final got = await c
        .subscribe(['@a/b'], SubscribeOptions(initialBackoff: const Duration(milliseconds: 10), onOpen: () => opens++))
        .take(2)
        .map((m) => m.message)
        .toList()
        .timeout(const Duration(seconds: 5));
    expect(got, ['one', 'two']);
    expect(opens, 2);
    final subs = relay.requests.where((r) => r.request.url.path.endsWith('/json')).map((r) => r.pathAndQuery).toList();
    expect(subs[0], '/@a/b/json');
    expect(subs[1], '/@a/b/json?since=01JD0000000000000000000001');
    final acks = relay.requests.where((r) => r.request.url.path == '/v1/ack').map((r) => r.json).toList();
    expect(acks.first['id'], '01JD0000000000000000000001');
    expect(acks.first['via'], 'stream');
  });

  test('subscribe ends with the error on auth failures', () async {
    final relay = Relay((_, __) => Relay.json('{"error":"forbidden","message":"no scope"}', status: 403));
    await expectLater(
        SubEtha(httpClient: relay.client).subscribe(['@a/b']).first.timeout(const Duration(seconds: 5)),
        throwsA(isA<SubEthaException>().having((e) => e.code, 'code', 'forbidden')));
    expect(relay.requests.length, 1);
  });

  test('subscribe retries server errors', () async {
    var errors = 0;
    final relay = Relay((_, n) =>
        n < 3 ? Relay.json('{"error":"internal"}', status: 500) : Relay.lines(['{"id":"01X","topic":"@a/b","message":"ok"}'], hold: true));
    final m = await SubEtha(httpClient: relay.client)
        .subscribe(['@a/b'], SubscribeOptions(autoAck: false, initialBackoff: const Duration(milliseconds: 1), onError: (_) => errors++))
        .first
        .timeout(const Duration(seconds: 5));
    expect(m.message, 'ok');
    expect(errors, 2);
  });

  test('poll transport delivers new messages only', () async {
    final relay = Relay((_, n) => n == 1
        ? Relay.lines(['{"id":"01P1","topic":"@a/b","message":"p1"}'])
        : Relay.lines(['{"id":"01P1","topic":"@a/b","message":"p1"}', '{"id":"01P2","topic":"@a/b","message":"p2"}']));
    final got = await SubEtha(httpClient: relay.client)
        .subscribe(['@a/b'],
            const SubscribeOptions(transport: SubscribeTransport.poll, pollInterval: Duration(milliseconds: 10), autoAck: false))
        .take(2)
        .map((m) => m.message)
        .toList()
        .timeout(const Duration(seconds: 5));
    expect(got, ['p1', 'p2']);
    expect(relay.requests[0].pathAndQuery, contains('since=all'));
    expect(relay.requests[1].pathAndQuery, contains('since=01P1'));
  });

  test('Ed25519 signer matches the core', () async {
    final signer = await Ed25519DeviceSigner.fromSeed(Encoding.hexDecode(seedHex));
    expect(signer.deviceId, deviceId);
    expect((await RequestSigning.enrollmentProof(signer, 1763750000)).proof, enrollSig);
    final v = jsonDecode(File('../../spec/vectors/requests.json').readAsStringSync()) as Map<String, dynamic>;
    expect(v['nonce'], nonce);
    for (final c in (v['cases'] as List).cast<Map<String, dynamic>>()) {
      final name = c['name'] as String;
      final headers = (c['headers'] as Map<String, dynamic>).cast<String, String>();
      final url = Uri.parse(c['url'] as String);
      final body = utf8.encode(c['body'] as String);
      final time = c['time'] as int;
      final h = await RequestSigning.headers(signer, c['method'] as String, url, body, time, nonce: nonce, headers: headers);
      expect(h['X-Device-Signed-Headers'], c['signed_headers'], reason: name);
      expect(h['X-Device-Signature'], c['signature'], reason: name);
      expect(await RequestSigning.input(c['method'] as String, url, body, RequestSigning.headersToSign(deviceId, time, nonce, headers)), c['signing_input'], reason: name);
    }
    expect(await RequestSigning.input('GET', Uri.parse('https://X.test:443'), const [], const []),
        'subetha-req-v2\nGET\nx.test\n/\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await RequestSigning.input('GET', Uri.parse('http://127.0.0.1:8080/a%20b?q=1'), const [], const []),
        startsWith('subetha-req-v2\nGET\n127.0.0.1:8080\n/a%20b?q=1\n'));
    expect(RequestSigning.newNonce(), hasLength(22));
    expect(RequestSigning.newNonce(), isNot(RequestSigning.newNonce()));
    expect(() => RequestSigning.headers(signer, 'GET', Uri.parse('https://x.test/'), const [], 1, nonce: 'short'), throwsArgumentError);
    expect(() => signer.signEnvelope('{}'), throwsUnsupportedError);
  });

  test('device-signed requests replace the bearer token', () async {
    final relay = Relay((_, __) => Relay.json('{}'));
    final signer = await Ed25519DeviceSigner.fromSeed(Encoding.hexDecode(seedHex));
    final c = SubEtha(baseUrl: 'https://x.test', token: 'se_t', deviceSigner: signer, signRequests: true, httpClient: relay.client, clock: () => 1763750000);
    await c.ack('@a/b', '01Z');
    final r = relay.requests.single;
    final h = r.request.headers;
    expect(h['Authorization'], isNull);
    expect(h['X-Device-Id'], deviceId);
    expect(h['X-Device-Time'], '1763750000');
    final n = h['X-Device-Nonce']!;
    expect(n, matches(RegExp(r'^[A-Za-z0-9_-]{16,64}$')));
    // Verify the way the relay does: every listed header, with its value as sent.
    final listed = h['X-Device-Signed-Headers']!.split(',');
    expect(listed, ['x-device-id', 'x-device-time', 'x-device-nonce', 'content-type']);
    final input = await RequestSigning.input('POST', r.request.url, utf8.encode(r.body), [for (final k in listed) (k, h[k]!)]);
    expect(await Ed25519DeviceSigner.verify(utf8.encode(input), Encoding.base64urlDecode(h['X-Device-Signature']!), signer.publicKey), isTrue);
  });

  test('enrollment flow', () async {
    final relay = Relay((r, n) {
      if (r.request.url.path == '/v1/device/code') {
        return Relay.json(
            '{"device_code":"dc","user_code":"BCDF-GHJK","verification_uri":"https://x/console/#device","verification_uri_complete":"https://x/console/#device=BCDF-GHJK","expires_in":600,"interval":0}');
      }
      return n == 2 ? Relay.json('{"error":"authorization_pending"}', status: 400) : Relay.json('{"account_id":"acct_1"}');
    });
    final signer = await Ed25519DeviceSigner.fromSeed(Encoding.hexDecode(seedHex));
    final c = SubEtha(deviceSigner: signer, httpClient: relay.client, clock: () => 1763750000);
    final code = await c.startEnrollment(name: 'Pixel');
    expect(code.userCode, 'BCDF-GHJK');
    expect(relay.requests[0].json, {'device_id': deviceId, 'time': 1763750000, 'proof': enrollSig, 'name': 'Pixel'});
    expect(await c.awaitEnrollment(code), 'acct_1');
  });

  test('encoding, ULID and topic paths', () {
    expect(Encoding.base32(const []), '');
    expect(Encoding.base32(const [0x66]), 'my');
    expect(Encoding.base32(utf8.encode('foobar')), 'mzxw6ytboi');
    expect(Encoding.base64urlDecode(Encoding.base64url(const [0xfb, 0xff])), [0xfb, 0xff]);
    expect(Ulid.next(), hasLength(26));
    expect(SubEtha.topicPath(['@a/b', '@a/c']), '@a/b,@a/c');
    expect(() => SubEtha(signRequests: true), throwsArgumentError);
  });
}
