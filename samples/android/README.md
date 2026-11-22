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
- The Edge tab sends messages **by sound** between two phones with no network:
  `AndroidAudio` (AudioTrack/AudioRecord) is the platform half, and `org.subetha.core.AudioLink`
  plus an `EdgeGossipNode` from `org.subetha:subetha-core` do the modem and gossip. It needs
  the core library in the APK:

  ```bash
  rustup target add aarch64-linux-android x86_64-linux-android
  cargo install cargo-ndk
  cargo ndk -t arm64-v8a -t x86_64 -o samples/android/app/src/main/jniLibs build -p subetha-core --features uniffi --release
  ```

  (from the repo root). Without it the app still runs and the Edge tab says what's missing.
  BLE (`BleLink`) and QR come next.
