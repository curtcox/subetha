# Flutter doorbell

The scripted doorbell flow (see `samples/README.md`) on the pure-Dart `subetha` package
(`sdk/flutter`, path dependency).

```bash
cd samples/flutter
flutter create . --platforms=android,ios,web --project-name subetha_doorbell   # generates the platform folders once
flutter run
```

Only `lib/` and `pubspec.yaml` are committed; `flutter create .` adds the platform runners.
Android needs the `INTERNET` permission in `android/app/src/main/AndroidManifest.xml`, which
`flutter create` adds for debug builds only.

## Edge tab

The Edge tab uses the Rust core through the [`subetha_core`](../../sdk/flutter_core) plugin
(flutter_rust_bridge; cargokit compiles the core when the app builds, so you need Rust, plus the
Android NDK or Xcode). `lib/edge.dart` wires its drivers to platform plugins:

- **Sound**: `audioplayers` plays the modem frame as a WAV, `record` streams 48 kHz PCM from the
  microphone into an `AudioLink`.
- **QR**: `qr_flutter` shows `QrSender` frames at 8 a second, `mobile_scanner` feeds scanned
  strings to a `QrReceiver`.
- **Bluetooth**: `flutter_reactive_ble` connects as a central to phones running the Android or
  iOS sample (they advertise the spec §11.3 service) and runs a `BleLink` per connection.
  Flutter has no maintained peripheral plugin, so two Flutter phones don't connect to each
  other; pair them with a native sample or the Edge lab page instead.
- **Bridge to relay**: with the Doorbell tab connected, an `EdgeBridge` forwards between the
  relay and the edge (see the offline BLE-hop demo in `samples/android/README.md`).

After `flutter create .`, add the permissions the plugins need:

- Android (`android/app/src/main/AndroidManifest.xml`): `INTERNET`, `RECORD_AUDIO`, `CAMERA`,
  `BLUETOOTH_SCAN` (with `android:usesPermissionFlags="neverForLocation"`), `BLUETOOTH_CONNECT`,
  and `ACCESS_FINE_LOCATION` with `android:maxSdkVersion="30"`. Set `minSdkVersion` to at least 23.
- iOS (`ios/Runner/Info.plist`): `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`,
  `NSBluetoothAlwaysUsageDescription`.

On the web the core isn't available, and the Edge tab says so; the Doorbell tab still works.
