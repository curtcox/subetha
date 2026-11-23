# Android doorbell (Kotlin + Jetpack Compose)

The scripted doorbell flow (see `samples/README.md`) on `us.subetha:subetha`, which this
build takes from `sdk/kotlin` through a composite build (`includeBuild("../../sdk/kotlin")`).

```bash
cd samples/android
gradle :app:assembleDebug          # needs the Android SDK (ANDROID_HOME); CI: .github/workflows/mobile.yml
adb install app/build/outputs/apk/debug/app-debug.apk
```

- `DoorbellViewModel` connects, collects `client.subscribe(topic)` into the inbox, rings with
  `publish`, and shows `estimate` (dry run) results.
- The Edge tab sends messages **by sound** between two phones with no network:
  `AndroidAudio` (AudioTrack/AudioRecord) is the platform half, and `us.subetha.core.AudioLink`
  plus an `EdgeGossipNode` from `us.subetha:subetha-core` do the modem and gossip. It needs
  the core library in the APK:

  ```bash
  rustup target add aarch64-linux-android x86_64-linux-android
  cargo install cargo-ndk
  cargo ndk -t arm64-v8a -t x86_64 -o samples/android/app/src/main/jniLibs build -p subetha-core --features uniffi --release
  ```

  (from the repo root). Without it the app still runs and the Edge tab says what's missing.
- **QR** on the Edge tab: "Show as QR" animates a message as fountain-coded frames
  (`us.subetha.core.QrSender`, spec §11.2) at 8 frames a second; "Scan QR" decodes them from
  the camera (CameraX frames, ZXing, `QrReceiver`). The scanner can start late or miss frames.
  The Edge lab page (`/tools/edge.html`) shows and scans the same codes.
- **Bluetooth** on the Edge tab: `AndroidBle` makes the phone both a peripheral (GATT server
  with the spec §11.3 service, advertising) and a central (scans for that service and
  connects), and gives every connection an `us.subetha.core.BleLink` for chunking and gossip.
  Phones in range exchange summaries and fetch what they're missing, so a message hops from
  phone to phone (each envelope's `hops` limits how far). Web Bluetooth pages (the Edge lab at
  `/tools/edge.html`) can connect to the phone as centrals.
- **LAN** on the Edge tab: "Join LAN" runs `LanNode` from the Kotlin SDK, which finds phones
  (and `subetha lan` on laptops) on the same Wi-Fi by UDP multicast beacons and gossips with them
  over unicast UDP (spec §11.5). The app holds a `WifiManager.MulticastLock` while it's on,
  because most phones drop multicast otherwise.
- **Bridge to relay**: with the Doorbell tab connected, the Edge tab's bridge (`EdgeBridge`)
  puts relay messages on the topic into the gossip node, where Bluetooth peers pick them up,
  and publishes messages heard over sound or Bluetooth to the relay. Uplinks are billed to the
  Doorbell tab's token.

### Offline BLE-hop demo

Two phones with the core library, the same topic on both Edge tabs:

1. Phone A (online): connect on the Doorbell tab, then on the Edge tab tap **Bluetooth on** and
   **Bridge to relay**.
2. Phone B (airplane mode with Bluetooth turned back on): tap **Bluetooth on**. The button
   shows `1 peers` once the phones connect.
3. `curl -H "Authorization: Bearer $SUBETHA_TOKEN" -d "ding" https://subetha.us/@me/doorbell`:
   A shows `relay: ding` and B shows `Bluetooth: ding`.
4. On B, type a message and tap **Send by sound**: it also goes out over Bluetooth, A uplinks
   it, and it shows up in the console and on the Doorbell tab.
