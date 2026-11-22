import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

// Flutter's navigator Route would clash with SubEtha's message Route.
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart' hide Route;
import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:record/record.dart';
import 'package:subetha/subetha.dart';
import 'package:subetha_core/subetha_core.dart';

/// Set by `main()`: null when the core loaded, otherwise why it didn't (e.g. on the web).
String? coreError;

/// The Doorbell tab's connected client, for the relay bridge.
final connectedClient = ValueNotifier<SubEtha?>(null);

final _service = Uuid.parse('53554245-5448-4100-8000-5ebe7a000000');
final _inbox = Uuid.parse('53554245-5448-4100-8000-5ebe7a000001');
final _outbox = Uuid.parse('53554245-5448-4100-8000-5ebe7a000002');

/// Edge transports between phones, no network, through the Rust core (`subetha_core`). One
/// gossip node holds what this phone has seen:
/// - Sound: a message as a 16-FSK modem frame (spec §11.1), played and recorded at 48 kHz.
/// - QR: fountain-coded animated QR frames (spec §11.2), shown and scanned with the camera.
/// - Bluetooth: connects as a central to phones running the Android or iOS sample (which are
///   peripherals) and gossips (spec §11.3/§11.4).
/// - Bridge: with the Doorbell tab connected, relay messages on the topic enter the node and
///   edge messages are published to the relay (PLAN §3).
class EdgeScreen extends StatefulWidget {
  const EdgeScreen({super.key});
  @override
  State<EdgeScreen> createState() => _EdgeScreenState();
}

class _EdgeScreenState extends State<EdgeScreen> {
  final _topic = TextEditingController(text: '@me/doorbell');
  final _text = TextEditingController(text: 'Ding dong');
  final _heard = <String>[];
  String _status = '';

  GossipNode? _nodeOrNull;
  final _player = AudioPlayer();
  final _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _mic;
  AudioLink? _listenLink;

  QrSender? _qr;
  int _qrSeq = 0;
  Timer? _qrTimer;
  bool _scanning = false;
  QrReceiver? _qrReceiver;

  final _ble = FlutterReactiveBle();
  StreamSubscription<DiscoveredDevice>? _scan;
  final _peers = <String, _Peer>{};

  EdgeBridge? _bridge;

  GossipNode get _node {
    final n = _nodeOrNull ??= GossipNode(requireSignatures: false);
    n.subscribe(topic: _topic.text.trim());
    return n;
  }

  int get _now => DateTime.now().millisecondsSinceEpoch ~/ 1000;

  void _say(String s) {
    if (mounted) setState(() => _status = s);
  }

  /// A new envelope for the message box, held by the node (so Bluetooth peers get it) and
  /// uplinked if bridging.
  String _publishLocally() {
    final env = jsonEncode({'id': newMessageId(), 'time': _now, 'topic': _topic.text.trim(), 'message': _text.text, 'hops': 1});
    _node.publish(envelopeJson: env, nowSecs: BigInt.from(_now));
    _resyncAll();
    _bridge?.uplink(env);
    return env;
  }

  /// A new envelope from any edge link: show it, tell Bluetooth peers, uplink it.
  void _received(String env, String via) {
    final m = (jsonDecode(env) as Map)['message'];
    if (mounted) setState(() => _heard.insert(0, '$via: $m'));
    _resyncAll();
    _bridge?.uplink(env);
  }

  // ---- sound ----

  Future<void> _sendBySound() async {
    try {
      final payload = deliverPayload([_publishLocally()]);
      final samples = AudioLink(AudioLink.modemRate, play: (_) {}, onPayload: (_) {}).samples(payload);
      await _player.play(BytesSource(_wav(samples, AudioLink.modemRate), mimeType: 'audio/wav'));
      _say('Playing ${payload.length} bytes as sound');
    } catch (e) {
      _say("Couldn't send: $e");
    }
  }

  Future<void> _toggleListening() async {
    if (_mic != null) {
      await _mic!.cancel();
      await _recorder.stop();
      setState(() => _mic = null);
      _say('Stopped listening');
      return;
    }
    if (!await _recorder.hasPermission()) return _say('Microphone permission denied');
    const rate = AudioLink.modemRate;
    final link = _listenLink ??= AudioLink(rate, play: (_) {}, onPayload: (p) {
      for (final env in acceptPayload(_node, p)) {
        _received(env, 'sound');
      }
    });
    final stream = await _recorder.startStream(const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: rate, numChannels: 1));
    setState(() => _mic = stream.listen((bytes) => link.onSamples(_pcm16ToFloat(bytes))));
    _say('Listening…');
  }

  // ---- QR ----

  void _toggleQr() {
    _qrTimer?.cancel();
    if (_qr != null) return setState(() => _qr = null);
    try {
      final sender = QrSender(deliverPayload([_publishLocally()]));
      setState(() {
        _qr = sender;
        _qrSeq = 0;
      });
      _qrTimer = Timer.periodic(const Duration(milliseconds: 125), (_) => setState(() => _qrSeq++));
      _say('Showing ${sender.sourceBlocks} block(s) as QR frames');
    } catch (e) {
      _say("Couldn't make QR frames: $e");
    }
  }

  void _onScan(BarcodeCapture capture) {
    final receiver = _qrReceiver ??= QrReceiver((p) {
      for (final env in acceptPayload(_node, p)) {
        _received(env, 'QR');
      }
    });
    for (final b in capture.barcodes) {
      final text = b.rawValue;
      if (text == null) continue;
      final p = receiver.push(text);
      if (p != null && !p.complete) _say('QR: ${p.known} of ${p.total} blocks');
    }
  }

  // ---- Bluetooth (central) ----

  void _toggleBluetooth() {
    if (_scan != null) {
      _scan!.cancel();
      for (final p in _peers.values) {
        p.close();
      }
      setState(() {
        _scan = null;
        _peers.clear();
      });
      return _say('Bluetooth off');
    }
    _node; // subscribe to the topic before peers connect
    setState(() => _scan = _ble.scanForDevices(withServices: [_service]).listen(_connect, onError: (Object e) => _say('Scan failed: $e')));
    _say('Scanning for phones running the SubEtha sample…');
  }

  void _connect(DiscoveredDevice d) {
    if (_peers.containsKey(d.id) || _peers.length >= 4) return;
    final peer = _Peer();
    _peers[d.id] = peer;
    peer.connection = _ble.connectToDevice(id: d.id, connectionTimeout: const Duration(seconds: 10)).listen((u) async {
      if (u.connectionState == DeviceConnectionState.connected && peer.link == null) {
        try {
          final mtu = await _ble.requestMtu(deviceId: d.id, mtu: 247).catchError((_) => BleLink.defaultAttMtu);
          final inbox = QualifiedCharacteristic(serviceId: _service, characteristicId: _inbox, deviceId: d.id);
          final outbox = QualifiedCharacteristic(serviceId: _service, characteristicId: _outbox, deviceId: d.id);
          final link = BleLink(_node, attMtu: mtu, onMessage: (env) => _received(env, 'Bluetooth'), write: (chunk) {
            // One GATT write at a time, in order.
            peer.writes = peer.writes.then((_) => _ble.writeCharacteristicWithResponse(inbox, value: chunk)).catchError((_) {});
          });
          peer.notifications = _ble.subscribeToCharacteristic(outbox).listen(link.receive);
          peer.link = link;
          link.resync();
          if (mounted) setState(() {});
          _say('Connected to ${d.name.isEmpty ? d.id : d.name}');
        } catch (e) {
          _say('Bluetooth: $e');
        }
      } else if (u.connectionState == DeviceConnectionState.disconnected) {
        _peers.remove(d.id)?.close();
        if (mounted) setState(() {});
      }
    }, onError: (Object e) {
      _peers.remove(d.id)?.close();
      _say('Bluetooth: $e');
    });
  }

  void _resyncAll() {
    for (final p in _peers.values) {
      p.link?.resync();
    }
  }

  // ---- relay bridge ----

  Future<void> _toggleBridge() async {
    if (_bridge != null) {
      await _bridge!.close();
      setState(() => _bridge = null);
      return _say('Bridge off');
    }
    final client = connectedClient.value;
    if (client == null) return _say('Connect on the Doorbell tab first');
    final topic = _topic.text.trim();
    setState(() => _bridge = EdgeBridge(client, _node, [topic], since: '10m', onDownlink: (env) {
          _resyncAll();
          final m = (jsonDecode(env) as Map)['message'];
          if (mounted) setState(() => _heard.insert(0, 'relay: $m'));
        }, onError: (e) => _say('Bridge: $e')));
    _say('Bridging $topic to the relay');
  }

  @override
  void dispose() {
    _qrTimer?.cancel();
    _mic?.cancel();
    _recorder.dispose();
    _player.dispose();
    _scan?.cancel();
    for (final p in _peers.values) {
      p.close();
    }
    _bridge?.close();
    _topic.dispose();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (coreError != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text("The SubEtha core didn't load ($coreError). The Edge tab needs a native build (Android, iOS, desktop)."),
      );
    }
    final connected = _peers.values.where((p) => p.link != null).length;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Phones with no network: sound, animated QR, and Bluetooth gossip with the Android and iOS samples. '
            'Same topic everywhere.', style: theme.textTheme.bodySmall),
        TextField(controller: _topic, decoration: const InputDecoration(labelText: 'Topic')),
        TextField(controller: _text, decoration: const InputDecoration(labelText: 'Message')),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton(onPressed: _sendBySound, child: const Text('Send by sound')),
          OutlinedButton(onPressed: _toggleListening, child: Text(_mic != null ? 'Stop listening' : 'Listen')),
          OutlinedButton(onPressed: _toggleQr, child: Text(_qr != null ? 'Hide QR' : 'Show as QR')),
          OutlinedButton(onPressed: () => setState(() => _scanning = !_scanning), child: Text(_scanning ? 'Stop scanning' : 'Scan QR')),
          OutlinedButton(onPressed: _toggleBluetooth, child: Text(_scan != null ? 'Bluetooth off ($connected peers)' : 'Bluetooth on')),
          ValueListenableBuilder<SubEtha?>(
            valueListenable: connectedClient,
            builder: (_, client, __) => OutlinedButton(
              onPressed: _bridge != null || client != null ? _toggleBridge : null,
              child: Text(_bridge != null ? 'Stop bridging' : 'Bridge to relay'),
            ),
          ),
        ]),
        if (_status.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_status, style: theme.textTheme.bodySmall)),
        if (_qr != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: QrImageView(data: _qr!.text(_qrSeq), errorCorrectionLevel: QrErrorCorrectLevel.L, backgroundColor: Colors.white),
          ),
        if (_scanning) SizedBox(height: 280, child: MobileScanner(onDetect: _onScan)),
        const SizedBox(height: 12),
        Text('Heard', style: theme.textTheme.titleMedium),
        if (_heard.isEmpty) const Text('Nothing yet'),
        for (final h in _heard) Card(child: Padding(padding: const EdgeInsets.all(12), child: Text(h))),
      ],
    );
  }
}

class _Peer {
  StreamSubscription<ConnectionStateUpdate>? connection;
  StreamSubscription<List<int>>? notifications;
  BleLink? link;
  Future<void> writes = Future.value();

  void close() {
    notifications?.cancel();
    connection?.cancel(); // cancelling the connection stream disconnects
  }
}

/// Little-endian 16-bit PCM to -1..1 floats.
List<double> _pcm16ToFloat(Uint8List bytes) {
  final data = ByteData.sublistView(bytes);
  return [for (var i = 0; i + 1 < bytes.length; i += 2) data.getInt16(i, Endian.little) / 32768];
}

/// A mono 16-bit WAV file for `samples` (-1..1).
Uint8List _wav(Float32List samples, int rate) {
  final b = ByteData(44 + samples.length * 2);
  void ascii(int at, String s) {
    for (var i = 0; i < s.length; i++) {
      b.setUint8(at + i, s.codeUnitAt(i));
    }
  }

  ascii(0, 'RIFF');
  b.setUint32(4, 36 + samples.length * 2, Endian.little);
  ascii(8, 'WAVEfmt ');
  b.setUint32(16, 16, Endian.little);
  b.setUint16(20, 1, Endian.little); // PCM
  b.setUint16(22, 1, Endian.little); // mono
  b.setUint32(24, rate, Endian.little);
  b.setUint32(28, rate * 2, Endian.little);
  b.setUint16(32, 2, Endian.little);
  b.setUint16(34, 16, Endian.little);
  ascii(36, 'data');
  b.setUint32(40, samples.length * 2, Endian.little);
  for (var i = 0; i < samples.length; i++) {
    b.setInt16(44 + i * 2, (samples[i].clamp(-1.0, 1.0) * 32767).round(), Endian.little);
  }
  return b.buffer.asUint8List();
}
