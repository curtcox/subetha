# Changelog

All notable changes to SubEtha are tracked here.

## Unreleased (v0.1.0-dev)

### Relay & Control Plane
- **Core relay MVP**: ntfy-compatible publish/subscribe (HTTP, JSON, SSE, WebSocket, poll, `since`, filters, multi-topic), `TopicDO`, `AccountDO` single-threaded prepaid ledger with credit leases, D1 migrations, KV caches, R2 attachments (`X-Filename`), and daily cron metering/reconciliation/backups.
- **Routing & policies**: intersection of account, topic, device, token, subscription, and message policies (`allow_transports`, `deny_transports`, `min_priority`, `max_cost_usd_micros`, `deadline_s`, timezone-aware quiet hours, rate/burst limits, kill switches). Enforced on both queued and live (`ws`/`sse`/`poll`) connections; deterministic `any` (cheapest-first) and `fast` (fastest-first) sorting; `mode: "all"` parallel delivery unaffected by acks.
- **Billing & fraud defenses**: Stripe Checkout top-ups, opt-in auto-recharge, payment history & printable receipts, rolling 12-month volume pricing tiers, $5 new-funds telephony hold (crediting back released/unused reservations), immediate unfreeze on top-up, frozen-account lifecycle emails, global & per-account telephony circuit breakers, Analytics Engine telemetry, and per-SKU usage breakdown (`/v1/usage`).
- **Transports**: live WS/SSE/poll; Web Push, FCM, APNs (with per-account BYO credentials and HTTP/2 relay); HMAC-signed webhooks + endpoint inspector; inbound/outbound email (with echo-loop guard); Slack OAuth + bidirectional channel bindings; Twilio SMS, MMS, WhatsApp, and Voice with DTMF ack + international opt-in countries priced daily; remote MCP server (`/mcp` + RFC 9728 `/.well-known/oauth-protected-resource/mcp`); Reticulum/LXMF gateway.

### SDKs, CLI & Edge Transports
- **Rust core (`sdk/core`)**: canonical JSON, Ed25519 signing, XChaCha20-Poly1305 E2EE, X25519 sealed-box wrapped topic keys, dedupe, store-and-forward outbox, routing planner, `TransportModule` trait, monotonic ULID generator, edge protocol codecs (audio FSK, fountain-coded QR, BLE chunking, gossip, LAN), and UniFFI bindings.
- **TypeScript SDK (`sdk/js`)**: client with full typed control-plane methods, `Outbox`, `routing` planner, `TransportModule`, Shadow DOM `<subetha-feed>` and `<subetha-send>` web components, browser edge shims (`/edge.js`), and full CLI (`pub`, `sub`, `tail`, `poll`, `cost`, `route`, `trace`, `ack`, `login`, `logout`, `whoami`, `lan`, `balance`, `prices`, `topics`, `devices`, `token`).
- **Python SDK (`sdk/python`)**: sync client with auto-E2EE, wrapped topic keys, `ack`/`auto_ack`, signature verification, file uploads, device-signed requests, and control-plane helpers.
- **Mobile SDKs & samples**: Swift (`sdk/swift`), Kotlin (`sdk/kotlin`), Flutter (`sdk/flutter`, `sdk/flutter_core`), React Native (`sdk/react-native`, `sdk/react-native-core`), and Doorbell + Edge sample apps on web, CLI, Python, MCP, iOS, Android, Flutter, and React Native.

### Docs, Tools & Infrastructure
- **Web console & tools (`apps/site`)**: live console dogfooding the SDK, pricing calculator, offline route simulator, Edge lab, OpenAPI API explorer, copy-as snippets in 6 languages, token builder, trace viewer, endpoint inspector, per-SKU usage table, and `/status/`.
- **Spec, pricing & infra**: OpenAPI 3.1 with drift test, shared conformance vectors (`spec/vectors`), generated pricing table with CI margin invariants, Cloudflare Terraform configuration (`infra/terraform`), and GitHub Actions CI/Mobile/Pages/Deploy/Nightly workflows.
