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
  static const defaultBaseUrl = 'https://subetha.us';
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
    Map<String, TopicKey> topicKeys = const {},
    http.Client? httpClient,
    int Function()? clock,
  })  : baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), ''),
        topicKeys = Map<String, TopicKey>.of(topicKeys),
        _http = httpClient ?? http.Client(),
        _ownsHttp = httpClient == null,
        clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch ~/ 1000) {
    if (signRequests && deviceSigner == null) throw ArgumentError('signRequests needs a deviceSigner');
    if (this.topicKeys.isNotEmpty && crypto == null) throw ArgumentError('topicKeys need an EnvelopeCrypto (core binding)');
  }

  /// Sets or clears (when [key] is null) the E2EE topic key used automatically for [topic].
  void setTopicKey(String topic, TopicKey? key) {
    if (key == null) {
      topicKeys.remove(topic);
      return;
    }
    if (crypto == null) throw StateError('topicKeys need an EnvelopeCrypto (core binding)');
    topicKeys[topic] = key;
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
      if (o.contentType != null) 'content_type': o.contentType,
      if (o.actions.isNotEmpty) 'actions': o.actions,
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

  /// Publishes a complete envelope as is: one that arrived over an edge link, or was signed or
  /// encrypted elsewhere. The relay-set `event` is dropped; everything else is sent unchanged,
  /// so signatures still verify.
  Future<Message> publishEnvelope(Map<String, dynamic> envelope, {String? idempotencyKey}) async {
    final env = Map<String, dynamic>.of(envelope)..remove('event');
    final headers = {if (idempotencyKey != null) 'Idempotency-Key': idempotencyKey};
    return Message(await _requestObject('POST', '/', body: env, headers: headers));
  }

  /// Dry run: who would get it, how, and the worst-case cost. Nothing is delivered.
  Future<Estimate> estimate(String topic, String message, [PublishOptions options = const PublishOptions()]) async {
    final env = await buildEnvelope(topic, message, options);
    return Estimate(await _requestObject('POST', '/', body: env, headers: {'X-Dry-Run': '1'}));
  }

  Map<String, String> _fileHeaders(
    String filename,
    String contentType,
    String? message,
    PublishOptions o, [
    Map<String, String> extra = const {},
  ]) {
    final h = <String, String>{'Content-Type': contentType, 'X-Filename': filename};
    if (message != null) h['X-Message'] = message;
    if (o.title != null) h['X-Title'] = o.title!;
    if (o.priority != null && o.priority != 3) h['X-Priority'] = '${o.priority}';
    if (o.tags.isNotEmpty) h['X-Tags'] = o.tags.join(',');
    if (o.click != null) h['X-Click'] = o.click!;
    if (o.icon != null) h['X-Icon'] = o.icon!;
    if (o.actions.isNotEmpty) h['X-Actions'] = jsonEncode(o.actions);
    if (o.contentType == 'text/markdown') {
      h['X-Markdown'] = '1';
    } else if (o.contentType != null) {
      h['X-Content-Type'] = o.contentType!;
    }
    if (o.expires != null) h['X-Expires'] = '${o.expires}';
    if (o.hops != null) h['X-Hops'] = '${o.hops}';
    final r = o.route;
    if (r != null) {
      if (r.mode != null) h['X-Route-Mode'] = r.mode!.name;
      if (r.maxCostUsd != null) h['X-Max-Cost'] = '${r.maxCostUsd}';
      if (r.deny.isNotEmpty) h['X-Deny'] = r.deny.join(',');
      if (r.allow.isNotEmpty) h['X-Allow'] = r.allow.join(',');
      if (r.deadlineS != null) h['X-Deadline'] = '${r.deadlineS}';
    }
    if (o.idempotencyKey != null) h['Idempotency-Key'] = o.idempotencyKey!;
    h.addAll(extra);
    return h;
  }

  /// Publishes a file attachment uploaded to R2 (`PUT /<topic>` with `X-Filename`).
  Future<Message> publishFile(
    String topic,
    String filename,
    List<int> bytes, {
    String contentType = 'application/octet-stream',
    String? message,
    PublishOptions options = const PublishOptions(),
  }) async {
    final text = await _send(
      'PUT',
      Uri.parse('$baseUrl/${topicPath([topic])}'),
      body: bytes,
      headers: _fileHeaders(filename, contentType, message, options),
    );
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, dynamic>) throw const FormatException('expected a JSON object');
    return Message(decoded);
  }

  /// Dry run for a file-attachment publish.
  Future<Estimate> estimateFile(
    String topic,
    String filename,
    List<int> bytes, {
    String contentType = 'application/octet-stream',
    String? message,
    PublishOptions options = const PublishOptions(),
  }) async {
    final text = await _send(
      'PUT',
      Uri.parse('$baseUrl/${topicPath([topic])}'),
      body: bytes,
      headers: _fileHeaders(filename, contentType, message, options, const {'X-Dry-Run': '1'}),
    );
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, dynamic>) throw const FormatException('expected a JSON object');
    return Estimate(decoded);
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
      final m = options.raw ? Message(raw) : _receive(raw);
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
  Future<Map<String, dynamic>> updateAccount(Map<String, dynamic> patch) => _requestObject('PATCH', '/v1/account', body: patch);
  Future<Map<String, dynamic>> balance() => _requestObject('GET', '/v1/balance');
  Future<Map<String, dynamic>> prices() => _requestObject('GET', '/v1/prices');
  Future<Map<String, dynamic>> trace(String topic, String id) =>
      _requestObject('GET', '/v1/traces/${Uri.encodeComponent(id)}?topic=${Uri.encodeQueryComponent(topic)}');
  Future<Map<String, dynamic>> ledger({int after = 0, int limit = 100}) => _requestObject('GET', '/v1/ledger?after=$after&limit=$limit');
  Future<Map<String, dynamic>> usage({int days = 30}) => _requestObject('GET', '/v1/usage?days=$days');
  Future<Map<String, dynamic>> audit({int limit = 50}) => _requestObject('GET', '/v1/audit?limit=$limit');
  Future<Map<String, dynamic>> topics() => _requestObject('GET', '/v1/topics');
  Future<Map<String, dynamic>> topic(String name) => _requestObject('GET', '/v1/topics/${topicPath([name])}');
  Future<Map<String, dynamic>> createTopic(String name, {Map<String, dynamic> policy = const {}}) =>
      _requestObject('PUT', '/v1/topics/${topicPath([name])}', body: {'policy': policy});
  Future<Map<String, dynamic>> deleteTopic(String name) => _requestObject('DELETE', '/v1/topics/${topicPath([name])}');
  Future<Map<String, dynamic>> devices() => _requestObject('GET', '/v1/devices');
  Future<Map<String, dynamic>> updateDevice(String id, Map<String, dynamic> patch) =>
      _requestObject('PATCH', '/v1/devices/${Uri.encodeComponent(id)}', body: patch);
  Future<Map<String, dynamic>> revokeDevice(String id) => _requestObject('DELETE', '/v1/devices/${Uri.encodeComponent(id)}');
  Future<Map<String, dynamic>> endpoints() => _requestObject('GET', '/v1/endpoints');
  Future<Map<String, dynamic>> deleteEndpoint(String id) => _requestObject('DELETE', '/v1/endpoints/${Uri.encodeComponent(id)}');
  Future<Map<String, dynamic>> subscriptions() => _requestObject('GET', '/v1/subscriptions');
  Future<Map<String, dynamic>> deleteSubscription(String id) => _requestObject('DELETE', '/v1/subscriptions/${Uri.encodeComponent(id)}');
  Future<Map<String, dynamic>> tokens() => _requestObject('GET', '/v1/tokens');
  Future<Map<String, dynamic>> revokeToken(String id) => _requestObject('DELETE', '/v1/tokens/${Uri.encodeComponent(id)}');
  Future<Map<String, dynamic>> listWrappedKeys({String? topic}) =>
      _requestObject('GET', topic != null ? '/v1/keys?topic=${Uri.encodeQueryComponent(topic)}' : '/v1/keys');
  Future<Map<String, dynamic>> deleteWrappedKeys(String topic, {String? kid, String? device}) {
    final q = <String>[
      'topic=${Uri.encodeQueryComponent(topic)}',
      if (kid != null) 'kid=${Uri.encodeQueryComponent(kid)}',
      if (device != null) 'device=${Uri.encodeQueryComponent(device)}',
    ];
    return _requestObject('DELETE', '/v1/keys?${q.join('&')}');
  }
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
