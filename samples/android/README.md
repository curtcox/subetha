# Android doorbell (Kotlin + Jetpack Compose)

The scripted doorbell flow (see `samples/README.md`) on `org.subetha:subetha`, which this
build takes from `sdk/kotlin` through a composite build (`includeBuild("../../sdk/kotlin")`).

```bash
cd samples/android
gradle :app:assembleDebug          # needs the Android SDK (ANDROID_HOME); CI: .github/workflows/mobile.yml
adb install app/build/outputs/apk/debug/app-debug.apk
```

- `DoorbellViewModel` connects, collects `client.subscribe(topic)` into the inbox, rings with
  `publish`, and shows `estimate` (dry run) results.
- The Edge tab is a stub. BLE, audio and QR come from the Rust core through
  `org.subetha:subetha-core` (see `sdk/kotlin/README.md` for building `libsubetha_core.so` with cargo-ndk).
