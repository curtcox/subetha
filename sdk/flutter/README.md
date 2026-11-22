# subetha (Dart / Flutter)

A pure-Dart SubEtha client: it works in Flutter apps (iOS, Android, desktop, web), on the
server and in CLIs. Dependencies: `package:http` and `package:cryptography` (pure-Dart
Ed25519/SHA-256).

```dart
import 'package:subetha/subetha.dart';

final client = SubEtha(token: const String.fromEnvironment('SUBETHA_TOKEN'));

await client.publish('@me/doorbell', 'ding', const PublishOptions(title: 'Front door', priority: 4));

final est = await client.estimate('@me/doorbell', 'ding',
    const PublishOptions(route: Route(mode: RouteMode.all, maxCostUsd: 0.05)));
print('worst case \$${est.estimateUsd}: ${est.plan}');

final sub = client.subscribe(['@me/doorbell'], const SubscribeOptions(since: '10m'))
    .listen((m) => print('${m.title}: ${m.message}'));
// later: await sub.cancel();
```

In Flutter apps, `import 'package:flutter/material.dart' hide Route;` (or prefix this package),
because Flutter's navigator `Route` clashes with SubEtha's message `Route`.

`subscribe` returns a single-subscription `Stream<Message>`. It reconnects with exponential
backoff (or `Retry-After`) and resumes with `since=<last id>`. It drops duplicate ids and acks
each message once it has been added to the stream. Errors that retrying can't fix (401, 402, 403,
404, …) are emitted as `SubEthaException` and close the stream. Cancelling the subscription
closes the connection.

### Device keys

```dart
final signer = await Ed25519DeviceSigner.generate();   // persist signer.seed in secure storage
final client = SubEtha(deviceSigner: signer);
final code = await client.startEnrollment(name: 'Pixel 9'); // show code.userCode
await client.awaitEnrollment(code);                         // after approval in the console
final device = SubEtha(deviceSigner: signer, signRequests: true); // X-Device-* headers (spec §8.1)
```

`Ed25519DeviceSigner` is deterministic (RFC 8032), so its signatures match the Rust core
byte for byte. The tests pin the same vector as `sdk/core/src/ffi.rs`.

## Tests

```bash
cd sdk/flutter && dart pub get && dart test
```

The tests use `package:http/testing.dart`'s `MockClient.streaming` as a mock relay (publish,
estimate, errors, poll, stream subscribe with dedupe/resume/acks, retry and terminal errors, poll
transport, request signing, enrollment).

## Core and edge features: `subetha_core`

Envelope signatures (canonical JSON), signature verification, E2EE, and the edge transports
(BLE gossip, the audio modem, animated QR) live in the Rust core (`sdk/core`). This package
defines the seams: `DeviceSigner.signEnvelope` and `EnvelopeCrypto` (`verify` / `encrypt` /
`decrypt`), and `SubEtha(crypto: …, topicKeys: …)` uses them once they are supplied.

The [`subetha_core`](../flutter_core) Flutter plugin supplies them through flutter_rust_bridge:
`CoreDeviceSigner`, `CoreEnvelopeCrypto`, and the edge drivers. Everything else (publish,
estimate, subscribe, acks, device-signed requests and enrollment) works here without it.
