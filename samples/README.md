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
6. **Edge.** A screen explaining that BLE, audio and animated QR transfer come from the Rust
   core (`sdk/core`: `edge::ble`, `edge::audio`, `edge::qr`, `edge::gossip`) through the
   platform bindings. It's a stub for now (track F).

| Sample | Stack | SDK | Built in CI |
|---|---|---|---|
| [`web`](web) | one static HTML page, `<subetha-feed>` / `<subetha-send>` + the JS client from `https://subetha.org/sdk.js` | `sdk/js` | — |
| [`cli`](cli) | shell scripts: `curl` and the `subetha` CLI | `sdk/js` CLI | — |
| [`agent-mcp`](agent-mcp) | MCP config for Claude Desktop / Claude Code + a fetch-only Node script | remote MCP | — |
| [`python`](python) | publish / subscribe scripts | `sdk/python` | — |
| [`android`](android) | Kotlin + Jetpack Compose | `sdk/kotlin` (composite build) | `assembleDebug` (mobile.yml) |
| [`ios`](ios) | SwiftUI (XcodeGen project) | `sdk/swift` | — (needs a signing setup) |
| [`flutter`](flutter) | Flutter (Material 3) | `sdk/flutter` (path dependency) | `flutter analyze` (mobile.yml, optional) |
| [`react-native`](react-native) | Expo (TypeScript) | `sdk/react-native` | — |

Use a token scoped to the topic (`subetha token create --scopes publish:@me/doorbell,subscribe:@me/doorbell --daily-cap 1`).
Point at a local relay (`wrangler dev`) with the base URL field or `SUBETHA_URL`.
