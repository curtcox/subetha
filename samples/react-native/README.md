# React Native doorbell (Expo)

The scripted doorbell flow (see `samples/README.md`) on `@subetha/react-native`. Metro
resolves it, and `@subetha/sdk`, from this repo's TypeScript sources (`metro.config.js`).

```bash
cd samples/react-native
npm install          # its own install: excluded from the pnpm workspace
npx expo run:android # or run:ios: a development build with the native modules
```

`npx expo start` runs it in Expo Go too, but Expo Go lacks Bluetooth, microphone streaming,
and UDP, so on the Edge tab only QR and sound playback work there. CI type-checks the app and
bundles it for both platforms with Metro (`npm run bundle`).

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

  Signed messages are dropped unless the Rust core is installed (Hermes can't verify Ed25519
  on its own). The tab's own messages are unsigned.

A standalone app would `npm install @subetha/react-native` instead of using the Metro aliases.
