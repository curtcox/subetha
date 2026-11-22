import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'models.dart';
import 'signer.dart';

/// SubEtha client: publish, dry-run estimates, poll, and subscribe with reconnect, dedupe and
/// acks. Mirrors the TypeScript reference client (`sdk/js/src/client.ts`).
///
/// ```dart
/// final client = SubEtha(token: 'se_…');
/// await client.publish('@me/doorbell', 'ding', const PublishOptions(title: 'Front door'));
/// client.subscribe(['@me/doorbell']).listen((m) => print(m.message));
/// ```
class SubEtha {
  static const defaultBaseUrl = 'https://subetha.org';
  static const version = '0.1.0';

  final String baseUrl;
  final String? token;
  final DeviceSigner? deviceSigner;

  /// Authenticate with the device signature instead of the bearer token (enrolled devices).
  final bool signRequests;

  /// Signature checks and E2EE, from the Rust core binding.
  final EnvelopeCrypto? crypto;
  final Map<String, TopicKey> topicKeys;
  final http.Client _http;
  final bool _ownsHttp;

  /// Unix seconds; replaceable in tests.
  final int Function() clock;

  SubEtha({
    String baseUrl = defaultBaseUrl,
    this.token,
    this.deviceSigner,
    this.signRequests = false,
    this.crypto,
    this.topicKeys = const {},
    http.Client? httpClient,
    int Function()? clock,
  })  : baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), ''),
        _http = httpClient ?? http.Client(),
        _ownsHttp = httpClient == null,
        clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch ~/ 1000) {
    if (signRequests && deviceSigner == null) throw ArgumentError('signRequests needs a deviceSigner');
    if (topicKeys.isNotEmpty && crypto == null) throw ArgumentError('topicKeys need an EnvelopeCrypto (core binding)');
  }

  /// Closes the HTTP client if this instance created it.
  void close() {
    if (_ownsHttp) _http.close();
  }

  // ---------------------------------------------------------------- HTTP

  Future<Map<String, String>> _headers(String method, Uri url, List<int>? body, [Map<String, String> extra = const {}]) async {
    final h = <String, String>{'User-Agent': 'subetha-dart/$version', 'Accept': 'application/json', ...extra};
    if (signRequests) {
      h.addAll(await RequestSigning.headers(deviceSigner!, method, url, body ?? const [], clock(), headers: Map.of(h)));
    } else if (token != null) {
      h['Authorization'] = 'Bearer $token';
    }
    return h;
  }

  Future<String> _send(String method, Uri url, {List<int>? body, Map<String, String> headers = const {}}) async {
    final req = http.Request(method, url)..headers.addAll(await _headers(method, url, body, headers));
    if (body != null) req.bodyBytes = body;
    final resp = await http.Response.fromStream(await _http.send(req));
    final text = utf8.decode(resp.bodyBytes, allowMalformed: true);
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw SubEthaException.fromResponse(resp.statusCode, text, resp.headers['retry-after']);
    }
    return text;
  }

  /// Any JSON API call: `await client.request('GET', '/v1/balance')`.
  Future<dynamic> request(String method, String path, {Object? body, Map<String, String> headers = const {}}) async {
    final bytes = body == null ? null : utf8.encode(jsonEncode(body));
    final h = {if (bytes != null) 'Content-Type': 'application/json', ...headers};
    final text = await _send(method, Uri.parse('$baseUrl$path'), body: bytes, headers: h);
    return text.trim().isEmpty ? <String, dynamic>{} : jsonDecode(text);
  }

  Future<Map<String, dynamic>> _requestObject(String method, String path, {Object? body, Map<String, String> headers = const {}}) async {
    final r = await request(method, path, body: body, headers: headers);
    if (r is! Map<String, dynamic>) throw FormatException('expected a JSON object from $path');
    return r;
  }

  // ---------------------------------------------------------------- publish

  /// The envelope [publish] would send, signed and/or encrypted as configured.
  Future<Map<String, dynamic>> buildEnvelope(String topic, String message, [PublishOptions o = const PublishOptions()]) async {
    var env = <String, dynamic>{
      ...o.extra,
      'topic': topic,
      'message': message,
      if (o.title != null) 'title': o.title,
      if (o.priority != null && o.priority != 3) 'priority': o.priority,
      if (o.tags.isNotEmpty) 'tags': o.tags,
      if (o.click != null) 'click': o.click,
      if (o.icon != null) 'icon': o.icon,
      if (o.expires != null) 'expires': o.expires,
      if (o.hops != null) 'hops': o.hops,
      if (o.route != null) 'route': o.route!.toJson(),
    };
    final topicKey = topicKeys[topic];
    final sign = o.sign ?? deviceSigner != null;
    final encrypt = o.encrypt ?? topicKey != null;
    if (sign || encrypt) {
      env['id'] = Ulid.next();
      env['time'] = clock();
    }
    if (encrypt) {
      if (topicKey == null) throw StateError('no E2EE key for $topic');
      env = jsonDecode(crypto!.encrypt(jsonEncode(env), topicKey.key, topicKey.kid)) as Map<String, dynamic>;
    }
    if (sign) {
      final signer = deviceSigner;
      if (signer == null) throw StateError('sign requested but no deviceSigner configured');
      env = jsonDecode(await signer.signEnvelope(jsonEncode(env))) as Map<String, dynamic>;
    }
    return env;
  }

  /// Publishes a message; returns the stored envelope as the relay saw it.
  Future<Message> publish(String topic, String message, [PublishOptions options = const PublishOptions()]) async {
    final env = await buildEnvelope(topic, message, options);
    final headers = {if (options.idempotencyKey != null) 'Idempotency-Key': options.idempotencyKey!};
    return Message(await _requestObject('POST', '/', body: env, headers: headers));
  }

  /// Dry run: who would get it, how, and the worst-case cost. Nothing is delivered.
  Future<Estimate> estimate(String topic, String message, [PublishOptions options = const PublishOptions()]) async {
    final env = await buildEnvelope(topic, message, options);
    return Estimate(await _requestObject('POST', '/', body: env, headers: {'X-Dry-Run': '1'}));
  }

  // ---------------------------------------------------------------- receive

  /// `@a/b,@a/c` with each path segment percent-encoded.
  static String topicPath(List<String> topics) {
    if (topics.isEmpty) throw ArgumentError('at least one topic is required');
    return topics
        .map((t) => t.split('/').map((s) => Uri.encodeComponent(s).replaceAll('%40', '@')).join('/'))
        .join(',');
  }

  Uri _subscribeUri(List<String> topics, {String? since, List<int> priority = const [], List<String> tags = const [], bool poll = false}) {
    final q = <String>[
      if (poll) 'poll=1',
      if (since != null) 'since=${Uri.encodeQueryComponent(since)}',
      if (priority.isNotEmpty) 'priority=${priority.join(',')}',
      if (tags.isNotEmpty) 'tags=${Uri.encodeQueryComponent(tags.join(','))}',
    ];
    return Uri.parse('$baseUrl/${topicPath(topics)}/json${q.isEmpty ? '' : '?${q.join('&')}'}');
  }

  List<Map<String, dynamic>> _ndjson(String text) => const LineSplitter()
      .convert(text)
      .where((l) => l.trim().isNotEmpty)
      .map((l) => jsonDecode(l))
      .whereType<Map<String, dynamic>>()
      .toList();

  /// Cached messages (since defaults to `all`).
  Future<List<Message>> poll(List<String> topics, {String since = 'all', List<int> priority = const [], List<String> tags = const []}) async {
    final text = await _send('GET', _subscribeUri(topics, since: since, priority: priority, tags: tags, poll: true));
    return _ndjson(text).map(_receive).toList();
  }

  /// Acknowledges a message so escalation stops.
  Future<void> ack(String topic, String id, {String via = 'http'}) async {
    await request('POST', '/v1/ack', body: {'topic': topic, 'id': id, 'via': via});
  }

  Message _receive(Map<String, dynamic> env) {
    final key = topicKeys[env['topic']];
    if (env['enc'] != null && key != null) {
      final dec = crypto!.decrypt(jsonEncode(env), key.key);
      if (dec != null) return Message(jsonDecode(dec) as Map<String, dynamic>);
    }
    return Message(env);
  }

  /// Subscribes to [topics]. Listening opens a JSON stream (or polls) and reconnects with
  /// exponential backoff, resuming from the last message id. Duplicates are dropped,
  /// encrypted messages decrypted, and each message is acked after it is added to the stream.
  /// Cancel the subscription to disconnect.
  ///
  /// Client errors that retrying can't fix (401, 402, 403, 404, …) are emitted as a
  /// [SubEthaException] and close the stream; network errors, 408, 429 and 5xx reconnect.
  Stream<Message> subscribe(List<String> topics, [SubscribeOptions options = const SubscribeOptions()]) {
    if ((options.verify || options.requireSignature) && crypto == null) {
      throw StateError('verify needs an EnvelopeCrypto (core binding)');
    }
    final dedupe = _Deduper();
    final via = options.transport == SubscribeTransport.poll ? 'poll' : 'stream';
    var since = options.since;
    var backoff = options.initialBackoff;
    var cancelled = false;
    StreamSubscription<String>? lines;
    Completer<void>? connection;
    late final StreamController<Message> controller;

    Future<void> handle(Map<String, dynamic> raw) async {
      final event = raw['event'];
      if (event is String && event != 'message') {
        if (event == 'open') {
          backoff = options.initialBackoff;
          options.onOpen?.call();
        }
        return;
      }
      if (!dedupe.accept(raw, clock())) return;
      if (raw['id'] is String) since = raw['id'] as String;
      if (options.verify || options.requireSignature) {
        if (raw['sig'] != null) {
          if (!crypto!.verify(jsonEncode(raw))) return;
        } else if (options.requireSignature) {
          return;
        }
      }
      final m = _receive(raw);
      if (cancelled) return;
      controller.add(m);
      final id = m.id;
      if (options.autoAck && id != null) {
        try {
          await ack(m.topic, id, via: via);
        } catch (e) {
          options.onError?.call(e);
        }
      }
    }

    Future<void> readStream() async {
      final uri = _subscribeUri(topics, since: since, priority: options.priority, tags: options.tags);
      final req = http.Request('GET', uri)..headers.addAll(await _headers('GET', uri, null));
      final resp = await _http.send(req);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        final text = await resp.stream.bytesToString();
        throw SubEthaException.fromResponse(resp.statusCode, text, resp.headers['retry-after']);
      }
      final done = connection = Completer<void>();
      late final StreamSubscription<String> sub;
      sub = resp.stream.transform(utf8.decoder).transform(const LineSplitter()).listen(
        (line) {
          if (line.trim().isEmpty) return;
          sub.pause(); // one line at a time, so acks follow delivery order
          Future(() async {
            final decoded = jsonDecode(line);
            if (decoded is Map<String, dynamic>) await handle(decoded);
          }).then((_) => sub.resume(), onError: (Object e) {
            if (!done.isCompleted) done.completeError(e);
          });
        },
        onError: (Object e) {
          if (!done.isCompleted) done.completeError(e);
        },
        onDone: () {
          if (!done.isCompleted) done.complete();
        },
        cancelOnError: true,
      );
      lines = sub;
      if (cancelled) await sub.cancel();
      await done.future;
      if (!cancelled) throw const _StreamEnded();
    }

    Future<void> run() async {
      while (!cancelled) {
        try {
          if (options.transport == SubscribeTransport.poll) {
            final text = await _send('GET', _subscribeUri(topics, since: since ?? 'all', priority: options.priority, tags: options.tags, poll: true));
            for (final raw in _ndjson(text)) {
              if (cancelled) return;
              await handle(raw);
            }
            since ??= '${clock()}';
            backoff = options.initialBackoff;
            await Future<void>.delayed(options.pollInterval);
            continue;
          }
          await readStream();
        } catch (e) {
          if (cancelled) return;
          if (e is SubEthaException && e.status >= 400 && e.status < 500 && e.status != 408 && e.status != 429) {
            controller.addError(e);
            await controller.close();
            return;
          }
          options.onError?.call(e);
          final ra = e is SubEthaException ? e.retryAfter : null;
          await Future<void>.delayed(ra != null ? Duration(milliseconds: (ra * 1000).round()) : backoff);
          final doubled = backoff * 2;
          backoff = doubled > options.maxBackoff ? options.maxBackoff : doubled;
        }
      }
    }

    controller = StreamController<Message>(
      onListen: () => run(),
      onCancel: () async {
        cancelled = true;
        final c = connection;
        if (c != null && !c.isCompleted) c.complete();
        await lines?.cancel();
      },
    );
    return controller.stream;
  }

  // ---------------------------------------------------------------- devices

  /// Step 1 of device enrollment: registers this device's key and returns a code the user
  /// approves in the console ([DeviceCode.verificationUriComplete]).
  Future<DeviceCode> startEnrollment({String? name, List<String> capabilities = const []}) async {
    final signer = deviceSigner;
    if (signer == null) throw StateError('enrollment needs a deviceSigner');
    final p = await RequestSigning.enrollmentProof(signer, clock());
    final r = await _requestObject('POST', '/v1/device/code', body: {
      'device_id': p.deviceId,
      'time': p.time,
      'proof': p.proof,
      if (name != null) 'name': name,
      if (capabilities.isNotEmpty) 'capabilities': capabilities,
    });
    return DeviceCode(
      deviceCode: '${r['device_code'] ?? ''}',
      userCode: '${r['user_code'] ?? ''}',
      verificationUri: '${r['verification_uri'] ?? ''}',
      verificationUriComplete: '${r['verification_uri_complete'] ?? ''}',
      expiresIn: (r['expires_in'] as num?)?.toInt() ?? 0,
      interval: (r['interval'] as num?)?.toInt() ?? 5,
    );
  }

  /// Step 2: polls until the user approves (returns the account id) or the code expires (throws).
  Future<String> awaitEnrollment(DeviceCode code) async {
    while (true) {
      try {
        final r = await _requestObject('POST', '/v1/device/token', body: {'device_code': code.deviceCode});
        return '${r['account_id'] ?? ''}';
      } on SubEthaException catch (e) {
        if (e.code != 'authorization_pending') rethrow;
      }
      await Future<void>.delayed(Duration(seconds: code.interval < 1 ? 1 : code.interval));
    }
  }

  // ---------------------------------------------------------------- control plane

  Future<Map<String, dynamic>> account() => _requestObject('GET', '/v1/account');
  Future<Map<String, dynamic>> balance() => _requestObject('GET', '/v1/balance');
  Future<Map<String, dynamic>> prices() => _requestObject('GET', '/v1/prices');
}

class _StreamEnded implements Exception {
  const _StreamEnded();
  @override
  String toString() => 'stream ended';
}

/// Seen-id LRU (spec §6). Ids compare case-insensitively; expired messages are dropped.
class _Deduper {
  static const capacity = 10000;
  final _seen = <String>{}; // LinkedHashSet: insertion order

  bool accept(Map<String, dynamic> env, int now) {
    final exp = env['expires'];
    if (exp is num && exp < now) return false;
    final id = env['id'];
    if (id is! String) return true;
    if (!_seen.add(id.toUpperCase())) return false;
    if (_seen.length > capacity) _seen.remove(_seen.first);
    return true;
  }
}
