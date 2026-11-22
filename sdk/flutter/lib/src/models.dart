import 'dart:convert';

/// A message envelope (spec §2) with typed accessors. All fields stay in [json].
class Message {
  final Map<String, dynamic> json;
  const Message(this.json);

  String? get id => _str('id');
  int? get time => _int('time');
  String get topic => _str('topic') ?? '';
  String? get message => _str('message');
  String? get title => _str('title');

  /// 1–5; absent means 3.
  int get priority => _int('priority') ?? 3;
  List<String> get tags => (json['tags'] as List?)?.whereType<String>().toList() ?? const [];
  String? get click => _str('click');
  int? get expires => _int('expires');

  /// `message` for messages; `open` / `keepalive` for stream control events.
  String? get event => _str('event');
  String? get sender => _str('sender');
  bool get isSigned => json['sig'] != null;

  /// Still encrypted (no topic key configured, or the wrong one).
  bool get isEncrypted => json['enc'] != null;

  dynamic operator [](String key) => json[key];

  String toJson() => jsonEncode(json);

  String? _str(String k) => json[k] is String ? json[k] as String : null;
  int? _int(String k) => json[k] is num ? (json[k] as num).toInt() : null;

  @override
  String toString() => 'Message(${toJson()})';
}

enum RouteMode { any, fast, all, cheap }

/// Per-message routing (spec §2 `route`). Transports are names like `ws`, `webpush`, `sms`.
class Route {
  final RouteMode? mode;

  /// Worst-case spend for this message, in US dollars.
  final double? maxCostUsd;
  final List<String> deny;
  final List<String> allow;
  final int? deadlineS;

  const Route({this.mode, this.maxCostUsd, this.deny = const [], this.allow = const [], this.deadlineS});

  Map<String, dynamic> toJson() => {
        if (mode != null) 'mode': mode!.name,
        if (maxCostUsd != null) 'max_cost_usd_micros': (maxCostUsd! * 1e6).floor(),
        if (deny.isNotEmpty) 'deny': deny,
        if (allow.isNotEmpty) 'allow': allow,
        if (deadlineS != null) 'deadline_s': deadlineS,
      };
}

class PublishOptions {
  final String? title;

  /// 1 (min) … 5 (max).
  final int? priority;
  final List<String> tags;
  final String? click;
  final String? icon;

  /// Unix seconds.
  final int? expires;
  final int? hops;
  final Route? route;
  final String? idempotencyKey;

  /// Sign with the client's device signer. Default: when a signer is configured.
  final bool? sign;

  /// Encrypt with the topic key. Default: when a key for the topic is configured.
  final bool? encrypt;

  /// Extension fields merged into the envelope (spec §2.2).
  final Map<String, dynamic> extra;

  const PublishOptions({
    this.title,
    this.priority,
    this.tags = const [],
    this.click,
    this.icon,
    this.expires,
    this.hops,
    this.route,
    this.idempotencyKey,
    this.sign,
    this.encrypt,
    this.extra = const {},
  }) : assert(priority == null || (priority >= 1 && priority <= 5), 'priority must be 1..5');
}

/// Dry-run result: route plan and worst-case cost. Nothing was delivered.
class Estimate {
  final Map<String, dynamic> json;
  const Estimate(this.json);

  int get estimateUsdMicros => (json['estimate_usd_micros'] as num?)?.toInt() ?? 0;
  double get estimateUsd => estimateUsdMicros / 1e6;

  /// One entry per planned delivery step (transport, cost, latency, …).
  List<Map<String, dynamic>> get plan =>
      (json['plan'] as List?)?.whereType<Map<String, dynamic>>().toList() ?? const [];
  Message? get message => json['message'] is Map<String, dynamic> ? Message(json['message'] as Map<String, dynamic>) : null;

  @override
  String toString() => 'Estimate(${jsonEncode(json)})';
}

enum SubscribeTransport { stream, poll }

class SubscribeOptions {
  /// `all`, a duration like `10m`, a unix time, or a message id. Default: new messages only.
  final String? since;
  final List<int> priority;
  final List<String> tags;
  final SubscribeTransport transport;
  final Duration pollInterval;

  /// Ack each message after it is delivered to the listener (stops escalation).
  final bool autoAck;

  /// Drop messages whose signature fails (needs an [EnvelopeCrypto]).
  final bool verify;

  /// Also drop unsigned messages.
  final bool requireSignature;

  /// Pass envelopes through as received (no E2EE decryption), e.g. to forward them.
  final bool raw;
  final Duration initialBackoff;
  final Duration maxBackoff;

  /// Called on each (re)connect.
  final void Function()? onOpen;

  /// Called with each error that triggers a reconnect.
  final void Function(Object error)? onError;

  const SubscribeOptions({
    this.since,
    this.priority = const [],
    this.tags = const [],
    this.transport = SubscribeTransport.stream,
    this.pollInterval = const Duration(seconds: 5),
    this.autoAck = true,
    this.verify = false,
    this.requireSignature = false,
    this.raw = false,
    this.initialBackoff = const Duration(milliseconds: 500),
    this.maxBackoff = const Duration(seconds: 30),
    this.onOpen,
    this.onError,
  });
}

/// Device-code enrollment (RFC 8628-style), from `POST /v1/device/code`.
class DeviceCode {
  final String deviceCode;
  final String userCode;
  final String verificationUri;
  final String verificationUriComplete;
  final int expiresIn;
  final int interval;

  const DeviceCode({
    required this.deviceCode,
    required this.userCode,
    required this.verificationUri,
    required this.verificationUriComplete,
    required this.expiresIn,
    required this.interval,
  });
}

/// An E2EE topic key (spec §5).
class TopicKey {
  final String kid;
  final List<int> key;
  TopicKey(this.kid, this.key) {
    if (key.length != 32) throw ArgumentError('topic keys are 32 bytes');
  }
}
