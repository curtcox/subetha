// Platform-independent drivers for edge transports (spec §11), mirroring sdk/js/src/edge/links.ts
// and the Kotlin and Swift SDKs. Platform plugins (BLE, audio, camera) only move bytes and samples
// in and out; these classes do the rest. Drive each from one isolate.
import 'dart:convert';
import 'dart:typed_data';

import 'rust/api/edge.dart';

int _nowSecs() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

/// The payload one-way links (sound, QR) carry for a set of envelopes: a gossip `deliver`.
Uint8List deliverPayload(List<String> envelopesJson) => edgeDeliverPayload(envelopesJson: envelopesJson);

/// The gossip message's `type` and, for `deliver`, how many envelopes it carries.
(String, int)? _gossipType(List<int> bytes) {
  try {
    final o = jsonDecode(utf8.decode(bytes));
    if (o is! Map || o['type'] is! String) return null;
    final envs = o['envelopes'];
    return (o['type'] as String, envs is List ? envs.length : 0);
  } catch (_) {
    return null;
  }
}

/// Hands a payload from a one-way link to [node]; returns the new envelopes (JSON).
List<String> acceptPayload(GossipNode node, List<int> payload, {int? nowSecs}) {
  if (_gossipType(payload)?.$1 != 'deliver') return const [];
  try {
    return node.handle(message: payload, nowSecs: BigInt.from(nowSecs ?? _nowSecs())).delivered;
  } catch (_) {
    return const [];
  }
}

/// One gossip conversation with a peer (spec §11.4) over any two-way link: send our summary
/// with [resync], feed whatever the peer sends to [receive]. New envelopes go to `onMessage`.
class GossipSession {
  final GossipNode node;
  final void Function(Uint8List) _send;
  final void Function(String) _onMessage;
  final int Function() _clock;

  GossipSession(this.node, {required void Function(Uint8List) send, required void Function(String) onMessage, int Function()? clock})
      : _send = send,
        _onMessage = onMessage,
        _clock = clock ?? _nowSecs;

  /// Sends our summary (on connect, and after publishing).
  void resync() => _send(node.summary(nowSecs: BigInt.from(_clock())));

  /// Handles one gossip message from the peer. Malformed messages are dropped.
  void receive(List<int> bytes) {
    final t = _gossipType(bytes);
    if (t == null) return;
    final GossipHandled h;
    try {
      h = node.handle(message: bytes, nowSecs: BigInt.from(_clock()));
    } catch (_) {
      return;
    }
    h.delivered.forEach(_onMessage);
    h.replies.forEach(_send);
    // We hold something new: advertise it (the peer may also hold more for us).
    if (t.$1 == 'deliver' && h.dropped.length < t.$2) resync();
  }
}

/// A gossip session over a BLE connection (spec §11.3): chunks outgoing messages for `write`
/// (a characteristic write or notification) and reassembles incoming chunks. Works as central
/// or peripheral. Set [attMtu] to the negotiated ATT MTU.
class BleLink {
  static const defaultAttMtu = 23;
  static const _reassemblyTimeoutMs = 30000;

  int attMtu;
  final void Function(Uint8List) _write;
  final int Function() _clockMs;
  final _reassembler = ChunkReassembler();
  late final GossipSession _session;
  int _seq = 0;

  BleLink(GossipNode node, {required void Function(Uint8List) write, required void Function(String) onMessage, this.attMtu = defaultAttMtu, int Function()? clockMs})
      : _write = write,
        _clockMs = clockMs ?? (() => DateTime.now().millisecondsSinceEpoch) {
    _session = GossipSession(node, send: _sendMessage, onMessage: onMessage, clock: () => _clockMs() ~/ 1000);
  }

  void _sendMessage(Uint8List bytes) {
    final s = _seq;
    _seq = (_seq + 1) & 0xffff;
    for (final c in bleChunk(seq: s, payload: bytes, attMtu: attMtu)) {
      _write(c);
    }
  }

  /// Feeds one notification or write from the peer. Bad chunks are dropped.
  void receive(List<int> chunk) {
    final now = BigInt.from(_clockMs());
    Uint8List? msg;
    try {
      msg = _reassembler.push(chunk: chunk, nowMs: now);
    } catch (_) {
      return;
    }
    _reassembler.prune(nowMs: now, timeoutMs: BigInt.from(_reassemblyTimeoutMs));
    if (msg != null) _session.receive(msg);
  }

  /// Sends our summary (on connect, and after publishing).
  void resync() => _session.resync();
}

/// Data over sound (spec §11.1) at the device's sample rate. [send] plays a payload through
/// `play`; feed microphone buffers to [onSamples] and decoded payloads reach `onPayload`.
/// Payloads are short (about 50 bytes/s): use [deliverPayload] / [acceptPayload] for envelopes.
class AudioLink {
  static const modemRate = 48000;

  final int sampleRate;
  final void Function(Float32List) _play;
  final void Function(Uint8List) _onPayload;
  final AudioReceiver _receiver;

  AudioLink(this.sampleRate, {required void Function(Float32List) play, required void Function(Uint8List) onPayload, double windowSeconds = 6})
      : _play = play,
        _onPayload = onPayload,
        _receiver = AudioReceiver(sampleRate: sampleRate, windowSeconds: windowSeconds);

  /// The samples for [payload] at this link's sample rate, without playing them.
  Float32List samples(List<int> payload) {
    final s = audioModulate(payload: payload);
    return sampleRate == modemRate ? s : audioResample(samples: s, fromRate: modemRate, toRate: sampleRate);
  }

  void send(List<int> payload) => _play(samples(payload));

  /// Feeds microphone samples (mono, -1..1, at the link's sample rate).
  void onSamples(List<double> samples) {
    final p = _receiver.push(samples: samples);
    if (p != null) _onPayload(p);
  }
}

/// Animated-QR sender (spec §11.2): an endless stream of fountain-coded frames for a payload,
/// as base45 text for alphanumeric QR codes. Show `text(0)`, `text(1)`, … one after another
/// (5–10 a second); a receiver needs about 1.1–1.5 × [sourceBlocks] of them, in any order.
class QrSender {
  /// Fills a version 12 QR code at error correction L (535 alphanumeric characters).
  static const defaultFrameSize = 356;

  final QrEncoder _encoder;

  QrSender(List<int> payload, {int frameSize = defaultFrameSize}) : _encoder = QrEncoder(payload: payload, frameSize: frameSize);

  /// How many frames carry the payload's blocks directly.
  int get sourceBlocks => _encoder.sourceBlocks();

  /// Frame [seq] as base45 text.
  String text(int seq) => _encoder.frameText(seq: seq);

  /// The frame size that fills a QR code holding [alphanumericChars] characters.
  static int frameSizeFor(int alphanumericChars) => alphanumericChars ~/ 3 * 2 + (alphanumericChars % 3 == 2 ? 1 : 0);
}

/// Collects scanned QR strings into a payload. Other QR codes are ignored, and a new transfer
/// replaces an unfinished one. `onPayload` gets each completed payload once.
class QrReceiver {
  final void Function(Uint8List) _onPayload;
  final _decoder = QrDecoder();
  Uint8List? _last;

  QrReceiver(this._onPayload);

  /// Feeds one scanned string; returns progress, or null if it wasn't a SubEtha frame.
  QrProgress? push(String text) {
    final p = _decoder.pushText(text: text);
    if (!p.accepted) return null;
    if (p.complete) {
      final r = _decoder.result();
      if (r != null && !_same(r, _last)) {
        _last = r;
        _onPayload(r);
      }
    }
    return p;
  }

  static bool _same(Uint8List a, Uint8List? b) {
    if (b == null || a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}
