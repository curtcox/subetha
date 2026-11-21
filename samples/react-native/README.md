# React Native doorbell (Expo)

The scripted doorbell flow (see `samples/README.md`) on `@subetha/react-native`. Metro
resolves it, and `@subetha/sdk`, from this repo's TypeScript sources (`metro.config.js`).

```bash
cd samples/react-native
npm install          # its own install: excluded from the pnpm workspace
npx expo start       # then press a (Android), i (iOS) or w (web)
```

- Subscribes over WebSocket via `subscribe()` from `@subetha/react-native`, because RN's fetch
  can't stream response bodies. It reconnects, resumes from the last id, dedupes and acks.
- "Route & cost" runs `client.estimate()` (dry run) and shows the plan and worst-case cost.
- The Edge tab is a stub. BLE, audio and QR come from the Rust core through
  uniffi-bindgen-react-native (see `sdk/react-native/README.md`).

A standalone app would `npm install @subetha/react-native` instead of using the Metro aliases.
