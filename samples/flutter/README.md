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

The Edge tab is a stub. BLE, audio and QR come from the Rust core through a
flutter_rust_bridge plugin (see `sdk/flutter/README.md`).
