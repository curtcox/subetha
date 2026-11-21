import 'dart:async';

// Flutter's navigator Route would clash with SubEtha's message Route.
import 'package:flutter/material.dart' hide Route;
import 'package:subetha/subetha.dart';

void main() => runApp(const DoorbellApp());

class DoorbellApp extends StatelessWidget {
  const DoorbellApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Doorbell',
        theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
        darkTheme: ThemeData(colorSchemeSeed: Colors.indigo, brightness: Brightness.dark, useMaterial3: true),
        home: const Home(),
      );
}

class Home extends StatefulWidget {
  const Home({super.key});
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(_tab == 0 ? 'Doorbell' : 'Edge')),
        body: _tab == 0 ? const DoorbellScreen() : const EdgeScreen(),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.notifications_outlined), label: 'Doorbell'),
            NavigationDestination(icon: Icon(Icons.wifi_tethering), label: 'Edge'),
          ],
        ),
      );
}

/// The scripted doorbell flow: connect, subscribe, inbox, ring, dry-run cost.
class DoorbellScreen extends StatefulWidget {
  const DoorbellScreen({super.key});
  @override
  State<DoorbellScreen> createState() => _DoorbellScreenState();
}

class _DoorbellScreenState extends State<DoorbellScreen> {
  final _token = TextEditingController();
  final _topic = TextEditingController(text: '@me/doorbell');
  final _base = TextEditingController(text: SubEtha.defaultBaseUrl);
  SubEtha? _client;
  StreamSubscription<Message>? _sub;
  final _inbox = <Message>[];
  String _status = 'Not connected';
  String? _estimate;
  bool _busy = false;

  void _connect() {
    _sub?.cancel();
    _client?.close();
    final client = SubEtha(baseUrl: _base.text.trim(), token: _token.text.trim());
    final topic = _topic.text.trim();
    setState(() {
      _client = client;
      _inbox.clear();
      _estimate = null;
      _status = 'Connecting…';
    });
    _sub = client
        .subscribe(
          [topic],
          SubscribeOptions(
            since: '1h',
            onOpen: () => setState(() => _status = 'Subscribed to $topic'),
            onError: (e) => setState(() => _status = 'Reconnecting: $e'),
          ),
        )
        .listen(
          (m) => setState(() => _inbox.insert(0, m)),
          onError: (Object e) => setState(() {
            _status = _describe(e);
            _client = null;
          }),
        );
  }

  void _disconnect() {
    _sub?.cancel();
    _client?.close();
    setState(() {
      _client = null;
      _status = 'Not connected';
    });
  }

  Future<void> _run(Future<void> Function(SubEtha c, String topic) action) async {
    final c = _client;
    if (c == null) return;
    setState(() => _busy = true);
    try {
      await action(c, _topic.text.trim());
    } catch (e) {
      setState(() => _status = _describe(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _ring() => _run((c, topic) => c.publish(topic, 'ding', const PublishOptions(title: 'Doorbell', tags: ['bell'])));

  Future<void> _estimateCost() => _run((c, topic) async {
        final e = await c.estimate(topic, 'ding', const PublishOptions(title: 'Doorbell', route: Route(mode: RouteMode.all)));
        final plan = e.plan.map((step) => step.entries.map((kv) => '${kv.key}=${kv.value}').join(', ')).join('\n');
        setState(() => _estimate = 'Worst case \$${e.estimateUsd.toStringAsFixed(6)}\n$plan');
      });

  static String _describe(Object e) => e is SubEthaException ? '${e.code} (HTTP ${e.status})' : '$e';

  @override
  void dispose() {
    _sub?.cancel();
    _client?.close();
    _token.dispose();
    _topic.dispose();
    _base.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final connected = _client != null;
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (!connected) ...[
          TextField(controller: _token, obscureText: true, decoration: const InputDecoration(labelText: 'Token')),
          TextField(controller: _topic, decoration: const InputDecoration(labelText: 'Topic')),
          TextField(controller: _base, decoration: const InputDecoration(labelText: 'Base URL'), keyboardType: TextInputType.url),
          const SizedBox(height: 12),
          FilledButton(onPressed: _connect, child: const Text('Subscribe')),
        ] else
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton(onPressed: _busy ? null : _ring, child: const Text('Ring "ding"')),
            OutlinedButton(onPressed: _busy ? null : _estimateCost, child: const Text('Route & cost')),
            TextButton(onPressed: _disconnect, child: const Text('Disconnect')),
          ]),
        const SizedBox(height: 8),
        Text(_status, style: theme.textTheme.bodySmall),
        if (_estimate != null)
          Card(child: Padding(padding: const EdgeInsets.all(12), child: Text(_estimate!, style: theme.textTheme.bodySmall))),
        const SizedBox(height: 16),
        Text('Inbox', style: theme.textTheme.titleMedium),
        if (_inbox.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('No messages yet')),
        for (final m in _inbox)
          ListTile(
            dense: true,
            title: Text(m.title ?? m.topic),
            subtitle: Text(m.message ?? ''),
            trailing: m.time == null
                ? null
                : Text(TimeOfDay.fromDateTime(DateTime.fromMillisecondsSinceEpoch(m.time! * 1000)).format(context)),
          ),
      ],
    );
  }
}

class EdgeScreen extends StatelessWidget {
  const EdgeScreen({super.key});

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.all(16),
        children: const [
          Text('Offline delivery over BLE (store-and-forward gossip), data-over-sound (16-FSK audio modem) '
              'and animated QR (fountain codes) come from the Rust core: sdk/core edge::ble, edge::gossip, '
              'edge::audio and edge::qr, through a flutter_rust_bridge plugin (see sdk/flutter/README.md).'),
          SizedBox(height: 12),
          Text('This screen is a stub (track F). The app supplies the radios: flutter_blue_plus with the core\'s GATT '
              'UUIDs and MTU chunking, 48 kHz audio capture/playback, and camera frames for QR.'),
        ],
      );
}
