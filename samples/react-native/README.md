# React Native doorbell (Expo)

The scripted doorbell flow (see `samples/README.md`) on `@subetha/react-native`. Metro
resolves it, and `@subetha/sdk`, from this repo's TypeScript sources (`metro.config.js`).

```bash
cd samples/react-native
npm run core:android # build the Rust core for Android (cargo-ndk, ANDROID_NDK_HOME); core:ios on a Mac
npm install          # its own install: excluded from the pnpm workspace
npx expo run:android # or run:ios: a development build with the native modules
```

The Rust core comes from [`@subetha/react-native-core`](../../sdk/react-native-core/README.md)
(`file:../../sdk/react-native-core`, copied rather than symlinked: see `.npmrc`), so build it
before `npm install`, and reinstall after rebuilding it. `core.ts` loads it with `loadCore`. It
is optional: in Expo Go, or without the native build, the app runs without it. The app enables React Native's New
Architecture (`newArchEnabled` in `app.json`), which the core's Turbo Module needs.

`npx expo start` runs it in Expo Go too, but Expo Go lacks Bluetooth, microphone streaming,
and UDP, so on the Edge tab only QR and sound playback work there. CI type-checks the app,
bundles it for both platforms with Metro (`npm run bundle`), and builds an x86_64 Android
development build with the core (`expo prebuild` + `gradlew assembleDebug`). The Pages build
publishes a web export (`npm run bundle:web`; `EXPO_BASE_URL` sets the sub-path, see
`app.config.js`) and that APK on the [sample apps page](https://curtcox.github.io/subetha/samples/).

- Subscribes over WebSocket via `subscribe()` from `@subetha/react-native`, because RN's fetch
  can't stream response bodies. It reconnects, resumes from the last id, dedupes and acks.
- "Route & cost" runs `client.estimate()` (dry run) and shows the plan and worst-case cost.
- The Edge tab (`Edge.tsx`) moves messages between nearby phones with no network, through
  `@subetha/react-native/edge`:
  - **Sound**: plays a modem frame as a WAV (expo-av) and listens with
    react-native-live-audio-stream.
  - **QR**: shows animated, fountain-coded QR frames (react-native-svg) and scans them
    (expo-camera).
  - **Bluetooth**: connects as a central (react-native-ble-plx) to a phone running the
    Android or iOS sample, which advertise as peripherals, and gossips.
  - **LAN**: finds peers on the same Wi-Fi by UDP multicast (react-native-udp) and gossips.
    iOS needs Apple's multicast networking entitlement for this.
  - **Bridge**: with the Doorbell tab connected, relay messages on the topic go to nearby
    phones, and messages heard nearby are published to the relay.

  With the Rust core, the tab signs its messages with a per-session device key and verifies
  signed messages it hears. Without it (Hermes can't do Ed25519 on its own), signed messages are
  dropped and the tab's own messages are unsigned.
- With the core, the Doorbell tab subscribes with `verify: true`, so badly signed messages are
  dropped.

A standalone app would `npm install @subetha/react-native` instead of using the Metro aliases.
