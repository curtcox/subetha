# SubEtha samples

Every platform sample implements the same **doorbell** flow (PLAN §14 track E exit criterion:
"the same sample app passes the scripted flow on iOS, Android, Flutter, RN"):

1. **Connect.** Enter a token and a topic (default `@me/doorbell`).
2. **Subscribe.** Open a subscription. It reconnects and resumes from the last id, drops
   duplicates, and acks each message.
3. **Inbox.** Show received messages, newest first.
4. **Ring.** Publish `ding` (title "Doorbell"). It appears in the inbox via the subscription.
5. **Route & cost.** Dry run (`X-Dry-Run: 1`) the same message and show the delivery plan and
   worst-case cost.
6. **Edge.** Send and receive directly without the relay over BLE, audio (16-FSK), animated QR
   (LT fountain code), and LAN UDP gossip via the Rust core (`sdk/core`: `edge::ble`,
   `edge::audio`, `edge::qr`, `edge::gossip`) and TypeScript SDK (`sdk/js/src/edge`), plus an
   offline-to-relay bridge.

| Sample | Stack | SDK | Built in CI |
|---|---|---|---|
| [`web`](web) | one static HTML page, `<subetha-feed>` / `<subetha-send>` + the JS client from `https://subetha.us/sdk.js` | `sdk/js` | published on GitHub Pages (`pages.yml`) |
| [`cli`](cli) | shell scripts: `curl` and the `subetha` CLI | `sdk/js` CLI | staging flow (`mobile.yml`, optional) |
| [`agent-mcp`](agent-mcp) | MCP config for Claude Desktop / Claude Code + a fetch-only Node script | remote MCP | staging flow (`mobile.yml`, optional) |
| [`python`](python) | publish / subscribe scripts | `sdk/python` | `pytest` (`ci.yml`) |
| [`android`](android) | Kotlin + Jetpack Compose | `sdk/kotlin` (composite build) | `assembleDebug` + APK artifact (`mobile.yml`) |
| [`ios`](ios) | SwiftUI (XcodeGen project) | `sdk/swift` | `xcodebuild` iOS Simulator (`mobile.yml`) |
| [`flutter`](flutter) | Flutter (Material 3) | `sdk/flutter` + `sdk/flutter_core` | `flutter analyze` (`mobile.yml`) |
| [`react-native`](react-native) | Expo (TypeScript) | `sdk/react-native` + `sdk/react-native-core` | Metro bundle + Android APK (`mobile.yml`), Expo web (`pages.yml`) |

Use a token scoped to the topic (`subetha token create --scopes publish:@me/doorbell,subscribe:@me/doorbell --daily-cap 1`).
Point at a local relay (`wrangler dev`) with the base URL field or `SUBETHA_URL`.
