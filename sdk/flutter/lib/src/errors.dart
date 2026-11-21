import 'dart:convert';

/// An error response from the relay (spec §9). [code] is the stable machine-readable code
/// (`insufficient_balance`, `rate_limited`, …; see spec/errors.json), [status] the HTTP status,
/// and [body] the full JSON error body.
class SubEthaException implements Exception {
  final String code;
  final int status;
  final String message;
  final Map<String, dynamic> body;

  /// Seconds from `Retry-After`, if sent.
  final double? retryAfter;

  const SubEthaException(this.code, this.status,
      {this.message = '', this.body = const {}, this.retryAfter});

  /// Worth retrying later: rate limits and server-side failures.
  bool get retryable => status == 429 || status >= 500;

  static const _statusCodes = {
    400: 'bad_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    413: 'message_too_large',
    429: 'rate_limited',
    500: 'internal',
    503: 'provider_unavailable',
  };

  factory SubEthaException.fromResponse(int status, String text, String? retryAfterHeader) {
    final retryAfter = retryAfterHeader == null ? null : double.tryParse(retryAfterHeader.trim());
    Map<String, dynamic>? obj;
    try {
      final decoded = jsonDecode(text);
      if (decoded is Map<String, dynamic>) obj = decoded;
    } catch (_) {}
    final code = obj?['error'];
    if (obj != null && code is String) {
      final http = obj['http'];
      return SubEthaException(code, http is int ? http : status,
          message: (obj['message'] ?? '').toString(), body: obj, retryAfter: retryAfter);
    }
    final trimmed = text.trim();
    return SubEthaException(_statusCodes[status] ?? 'http_$status', status,
        message: trimmed.length > 500 ? trimmed.substring(0, 500) : trimmed,
        body: obj ?? const {},
        retryAfter: retryAfter);
  }

  @override
  String toString() => message.isEmpty
      ? 'SubEthaException: $code (HTTP $status)'
      : 'SubEthaException: $code (HTTP $status): $message';
}
