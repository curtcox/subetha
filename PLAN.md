# SubEtha — Project Plan

> **subetha.us**: send and receive ntfy-style messages between any devices, over any transport,
> without either side knowing how (or to whom) the message is being delivered.

Status: **DRAFT v0.2**. Decisions made so far are in [§15](#15-decisions-and-open-questions), along with the remaining open questions. Assumptions are marked **(A)**.

---

## 1. Vision and principles

SubEtha is a hosted pub/sub relay. A sender publishes a message to a **topic**. Every device
subscribed to that topic gets it through whatever path works: a WebSocket, a phone push, SMS,
email, Slack, a Reticulum/LXMF mesh, a Bluetooth hop through a nearby phone, a burst of audio, or
an animated QR code on a screen.

Guiding principles:

1. **Topics, not addresses.** Devices only know topic names (and optionally keys). They never need
   to know other devices exist, what they are, or how they're reached.
2. **The SDK picks the route.** `subetha.publish("door", "opened")` and `subetha.subscribe("door")`
   are all an app needs. Transport selection, fallback, retry, dedupe, and store-and-forward
   happen inside the SDK and the relay.
3. **The owner stays in control.** Account owners can restrict, cap, prioritize, and audit every
   transport, device, token, and topic. Every message has a trace showing the route it took and
   what it cost.
4. **ntfy compatible on the wire.** `curl -d "hi" subetha.us/mytopic` works, and existing ntfy
   clients can point at subetha.us.
5. **No user can cost the service money.** Every metered action is prepaid from a balance, priced
   above its marginal cost, and checked against the balance *before* it runs.
6. **Profit grows with volume.** Every SKU has a strictly positive per-unit margin, and fixed costs
   are bounded and covered.
7. **Built for agents and scripts.** curl-able, OpenAPI, MCP server, CLI, `llms.txt`, dry-run cost
   estimates, idempotency keys, spending-capped tokens.

---

## 2. Like hashbin / unlike hashbin

| | hashbin.org | subetha.us |
|---|---|---|
| Hosting | Cloudflare | Cloudflare (Workers, Durable Objects, D1, R2, Queues, KV, Email Routing, Containers) |
| Payments | Stripe, prepaid account balance, no subscription | Same |
| Human auth | Clerk | Clerk (web console, OAuth for MCP/Slack installs) |
| Device auth | devicebasedauth.org | devicebasedauth.org for device enrollment and identity **(A — see open question 1)** |
| Pricing | Thin margin, never negative | Same, enforced by automated pricing invariants (§8) |
| Dev focus | API docs, working samples, built-in tools | Same, plus SDKs for 6+ platforms and sample apps |
| Core difference | — | **Device-to-device, transport-agnostic, location-agnostic delivery** |

---

## 3. Core concepts

| Concept | Description |
|---|---|
| **Account** | A Clerk user or org. Holds the balance, owns topics, devices, tokens, and policies. |
| **Device** | Any endpoint running the SDK or registered to receive messages: browser tab, phone, server, ESP32, CLI, agent. It has an Ed25519 identity key (enrolled through devicebasedauth.org; see open question 1) and declares the **capabilities** (transports) it can reach. |
| **Endpoint** | A non-SDK destination bound to a topic: an email address, phone number, Slack channel, webhook URL, LXMF address, or MCP agent inbox. Paid outbound endpoints must be **verified** (confirmation code) to prevent abuse. |
| **Topic** | The rendezvous point. Namespaced `@handle/name`, or an unguessable `t_<128-bit>` name for ntfy-style "secret URL" topics. Topics carry policies and an optional E2EE key. |
| **Subscription** | (Device or Endpoint) × Topic, plus a filter (priority, tags) and delivery preferences. |
| **Message** | An ntfy-compatible envelope plus SubEtha extensions (§4). |
| **Transport** | A pluggable path. It is either **relay-side** (runs on Cloudflare or a hosted gateway, metered) or **edge-side** (runs inside the SDK on a device: BLE, audio, QR/video, LAN; free, never touches our servers). |
| **Gateway** | Any process that bridges a transport to the relay. Hosted gateways (Reticulum) are metered. Anyone can run their own **BYO gateway** using the SDK. A phone with BLE and internet is a gateway for nearby offline devices. |
| **Policy** | Declarative rules on account, topic, device, token, and message that limit which transports may be used, cost caps, rates, quiet hours, allowed publishers, etc. |
| **Trace** | A per-message record of every hop, transport, attempt, ack, and µ$ charged. Visible to the account owner; never visible to other devices. |

### Who pays?
- **Publish** is charged to the **publisher's** token or account.
- **Fan-out and delivery** is charged to the **topic owner** by default. That keeps
  `curl -d hi subetha.us/@alice/doorbell` simple: Alice can allow anonymous or public publishing
  with a rate limit and a daily spend cap. *(Decided.)*
- Anonymous publishes to topics with no funded owner are rejected (HTTP 402).

---

## 4. Message format

A superset of the ntfy JSON message:

```jsonc
{
  "id": "01JD…",               // ULID, globally unique, used for dedupe across transports
  "time": 1763750000,
  "expires": 1763836400,
  "event": "message",
  "topic": "@alice/doorbell",
  "title": "Front door",
  "message": "Opened",
  "priority": 4,               // 1..5 as in ntfy
  "tags": ["door", "warning"],
  "click": "https://…",
  "actions": [ … ],            // ntfy action buttons
  "attachment": { "name": "snap.jpg", "url": "https://subetha.us/file/…", "size": 81234, "type": "image/jpeg" },

  // SubEtha extensions (all optional)
  "content_type": "text/plain",          // or application/json, application/octet-stream (base64)
  "sender": "dev_7Hq…",                  // device id; omitted unless the topic policy requires it
  "sig": "ed25519:…",                    // sender device signature over canonical envelope
  "enc": { "alg": "xchacha20poly1305", "kid": "topic-key-3" },  // E2EE: message/title/attachment encrypted
  "route": { "mode": "any", "max_cost_usd": 0.02, "deny": ["sms"], "deadline_s": 60 },
  "hops": 2                              // decremented by edge relays (BLE/LXMF) to stop loops
}
```

HTTP publish supports ntfy headers (`X-Title`, `X-Priority`, `X-Tags`, …) plus `X-Route-Mode`,
`X-Max-Cost`, `X-Deny`, `X-Allow`, `Idempotency-Key`, and `X-Dry-Run`.

The canonical spec, JSON Schema, and cross-SDK test vectors live in `/spec` and are the source of
truth for every implementation.

---

## 5. Routing and delivery

1. **Publish.** The request is authenticated (token, device signature, or anonymous plus topic
   policy). Policies are evaluated, the worst-case cost is reserved from the payer's credit lease,
   and the message goes to the topic's Durable Object.
2. **Fan-out.** The Topic DO resolves subscriptions. For each one it builds a **delivery plan**: an
   ordered list of transports allowed by `account ∩ topic ∩ subscription ∩ token ∩ message`
   policies, sorted by the route mode.
   - `any` (default): deliver once, by the cheapest viable path, escalating if no ack arrives.
   - `fast`: lowest latency first.
   - `all`: every allowed transport (for alarms).
   - `cheap`: free transports only; never escalate to paid ones.
3. **Escalation.** For example: live WebSocket → push (APNs/FCM/WebPush) → if unacked after N s and
   priority ≥ 4 → SMS → voice call. Each step is a Queue job with its own reservation.
4. **Ack and dedupe.** SDKs ack by message id over any transport. Duplicate arrivals (BLE plus
   WebSocket) are dropped by id. Unused reservations are released.
5. **Store and forward.** Messages are retained until they expire (metered storage), so
   reconnecting devices and gateways can catch up (`since=` like ntfy).
6. **Edge relaying.** SDKs gossip recent messages for topics they are subscribed to (or that are
   explicitly marked relayable) over local transports, with hop limits. Signatures and E2EE mean
   edge relays can't forge or read messages.

The relay never exposes to a device *which* other devices exist or how they were reached. The
owner sees this only in the trace.

---

## 6. Transports

| Transport | Side | Direction | Implementation | Notes |
|---|---|---|---|---|
| HTTP publish / JSON poll | relay | in/out | Workers (Hono) | ntfy-compatible paths |
| SSE / WebSocket / JSON stream | relay | out | Topic DO with WebSocket hibernation | cheap idle connections |
| Web Push | relay | out | VAPID from Worker | browsers, PWAs |
| APNs / FCM | relay | out | Worker → Apple/Google | sample apps; BYO credentials option |
| Webhook | relay | in/out | Worker + Queue, HMAC-signed | |
| Email | relay | in/out | In: Cloudflare Email Routing → Email Worker (`topic@in.subetha.us`). Out: Cloudflare Email Service (fallback Amazon SES) | outbound only to verified addresses |
| Slack | relay | in/out | Slack app (OAuth install), Events API in, `chat.postMessage` out | bind channel ↔ topic |
| Twilio SMS / MMS / WhatsApp | relay | in/out | Twilio REST + inbound webhook | US A2P 10DLC registration needed (started in Phase 0); verified numbers only |
| Twilio Voice | relay | out (+DTMF ack) | TwiML `<Say>` | escalation target for alarms |
| MCP | relay | in/out | Remote MCP server at `mcp.subetha.us` (Streamable HTTP, OAuth via Clerk). Tools: `publish`, `poll`, `wait_for_message`, `list_topics`, `create_topic`, `estimate_cost` | agents are devices too |
| Reticulum / LXMF | gateway | in/out | Python RNS + LXMF daemon in Cloudflare Containers (or a small VPS), linked to the relay by WebSocket. Each topic can be given an LXMF destination | BYO gateway supported |
| Bluetooth LE | edge | in/out | SDK: GATT service plus advertising; store-and-forward mesh; Web Bluetooth where supported | iOS background limits apply |
| Audio | edge | in/out | SDK data-over-sound modem (ggwave-style FSK, MIT-licensed lib or own) | short payloads, ids, wake-ups |
| Video / QR | edge | in/out | Animated QR with fountain codes (display ↔ camera) | air-gapped transfer |
| LAN | edge | in/out | mDNS/DNS-SD plus UDP/WebSocket | offline local networks |
| Later | — | — | Discord, Telegram, Matrix, MQTT, Meshtastic/LoRa, Signal (if feasible) | |

Each transport is a module that implements one interface (`capabilities()`, `send(envelope, endpoint)`,
`receive() → envelopes`, `costEstimate()`) on both the relay (TS) and SDK (Rust/TS) sides.

---

## 7. Architecture (Cloudflare)

```
             ┌──────────── subetha.us (Workers static assets: site, docs, console) ────────────┐
 clients ───▶│ api Worker (Hono): REST + ntfy-compat, auth (Clerk JWT | API token | device sig) │
             └──────┬──────────────┬─────────────────┬──────────────────┬──────────────────────┘
                    │              │                 │                  │
             TopicDO (per topic)  AccountDO        D1 (accounts,      KV (token→account cache,
             fan-out, WS hib.,    (per account)    devices, topics,   policy cache)
             short-term buffer    balance ledger,  subs, policies,
                    │             credit leases    ledger journal)    R2 (attachments, archives)
                    ▼
             Queues: deliver-{push,email,sms,voice,slack,webhook,lxmf}  → delivery Workers → providers
             Email Worker (inbound) · Slack/Twilio/Stripe webhook Workers · MCP Worker
             Containers: reticulum-gateway · Cron: reconciliation, storage metering, repricing
             Analytics Engine: usage metering & cost telemetry
```

- **Balance safety:** each account's balance lives in its `AccountDO`, which is single-threaded, so
  double-spends are impossible. Hot paths (Topic DOs, delivery Workers) take small **credit leases**
  (say 1¢) from the AccountDO and return unused amounts. Publishing never waits on D1, and the
  balance can never go below zero.
- **Money is integer micro-dollars (µ$).** Ledger entries are append-only (`topup`, `reserve`,
  `settle`, `release`, `refund`, `adjust`) and journaled to D1, with nightly reconciliation against
  Stripe.
- **Environments:** `local` (wrangler dev + Miniflare, Stripe test, Clerk dev), `staging`
  (`staging.subetha.us`, all providers in test mode), `production` (`subetha.us`).

---

## 8. Pricing model

### Rules
0. **No free relay usage.** Every action that touches the relay or a hosted gateway is prepaid. The
   only free things are edge transports (BLE, audio, QR, LAN), which run entirely on users' devices,
   and reading the public docs. Live API explorers on the site use the signed-in user's own balance.
   *(Decided.)*
1. **Prepaid only.** Top up with Stripe Checkout (min **$5** **(A)**). Optional auto-recharge
   (saved card, top up when below a threshold) is *not* a subscription.
2. **Price = cost × (1 + markup) + floor**, rounded up to a whole µ$. `pricing/costs.yaml` holds
   each SKU's measured marginal cost (Cloudflare, Twilio, email, Stripe share, overhead). The price
   table is **generated**, and CI fails if any SKU's margin drops below the floor (e.g. 15%).
3. **Reserve before act.** Each action reserves its worst-case cost, then settles to the actual cost
   (e.g. SMS segments). An insufficient balance gets HTTP 402 with the shortfall in the body.
   Nothing is ever billed after the fact.
4. **State costs rent.** Retained messages, attachments, devices, and verified endpoints are metered
   per resource-day. At zero balance, resources freeze, then get deleted after a grace period
   (e.g. 30 days, with emails). The bare account record costs almost nothing, and top-up margins
   cover it.
5. **Variable-cost providers are priced live.** Twilio prices vary by country, so a daily Cron pulls
   the Twilio Pricing API and regenerates per-destination prices. Destinations with unknown prices
   are rejected.
6. **Fixed costs are covered.** These are the Workers plan, Clerk beyond its free MAUs, Twilio
   numbers and 10DLC fees, the domain, the Apple developer program, etc. They're covered by a small
   per-top-up fee **(A)** plus the per-SKU floor. A `fixed-costs.yaml` and a monthly report show
   break-even volume.
7. **Volume discounts never cross the floor.** Larger top-ups get a lower markup tier, but margins
   stay strictly positive. Total profit = Σ(volume × unit margin) − bounded fixed costs, so it only
   rises with volume.
8. **Edge transports are free.** BLE, audio, QR, and LAN never touch the relay. Bridging them through
   a relay is billed as an ordinary relay delivery.

### Chargeback and fraud protection (so no user can cost money)
- Stripe Radar plus 3DS on top-ups. The chargeback fee is recovered from the balance where possible.
- **New-funds hold for expensive transports.** Funds from a first top-up can be spent on IP, push,
  Slack, and email right away. SMS and voice spend is capped (e.g. $5) until funds are X days old
  or the account has history.
- Outbound paid endpoints (phones, emails) must be verified by the recipient. That blocks spam and
  toll fraud (SMS pumping), and international SMS/voice are opt-in per country.
- Global and per-account circuit breakers trip if provider spend diverges from metered revenue.

### Illustrative price sheet (must be re-derived from verified costs)

| SKU | Approx. marginal cost | Proposed price |
|---|---|---|
| Publish (≤ 4 KB) | ~$0.0000015 | $0.000005 ($5 / million) |
| Delivery: WS/SSE/poll | ~$0.0000003 | $0.000001 |
| Delivery: Web Push / APNs / FCM | ~$0.000001 | $0.000005 |
| Delivery: webhook / Slack / MCP | ~$0.000002 | $0.00001 |
| Email out / in | ~$0.0001 / ~$0.00001 | $0.0005 / $0.0001 |
| SMS US (per segment) | ~$0.0083 + carrier fees | $0.015 |
| Voice US (per minute) | ~$0.014 + TTS | $0.03 |
| Reticulum via hosted gateway | container time amortized | $0.00005 |
| Message retention | D1/DO storage | $0.0000001 / msg-day |
| Attachment storage | R2 $0.015/GB-mo + ops | $0.03 / GB-mo + $0.00001 / upload |
| BLE / audio / QR / LAN (edge) | $0 | Free |

The console has a **pricing calculator** and every API call supports `X-Dry-Run: 1`, which returns
the route plan and cost estimate without charging.

---

## 9. Auth and access control

- **Humans:** Clerk (email, passkeys, OAuth). Orgs map to shared accounts and balances.
- **Devices:** devicebasedauth.org enrolls a device keypair (the owner approves it there) and the
  account links its devicebasedauth.org account; requests carry the device's DBA credential and a
  DPoP proof of its key, or are signed by an Ed25519 key the DBA device attached (D5).
- **API tokens:** scoped and revocable: `publish:@alice/*`, `subscribe:@alice/doorbell`, transport
  allow-lists, spend caps (per day / total), expiry, IP or origin restrictions. Browser-safe
  **publishable tokens** for web pages are tied to an origin and a single topic with a tight cap.
- **MCP / Slack:** OAuth 2.1 with Clerk as the authorization server.
- **E2EE (optional):** per-topic symmetric keys shared out-of-band (QR) or wrapped to device keys.
  The relay routes ciphertext.

### Policy management (console + API)
- Allow or deny transports per account, topic, device, or token.
- Cost caps: per message, per day, per month, per topic.
- Rate limits and burst limits. Quiet hours (downgrade to free transports).
- Priority thresholds per transport (e.g. SMS only if priority ≥ 4).
- Publisher allow-lists (device ids or tokens), and whether signatures are required.
- Region / country restrictions for SMS and voice.
- Kill switch: pause a topic, a device, or the whole account.

---

## 10. Developer and agent experience

- `curl -d "Backup done" subetha.us/@me/backups`, ntfy-compatible.
- **SDKs:** TypeScript (browser, Node, Deno, Bun, Workers), Swift, Kotlin, Dart/Flutter,
  React Native, and Python (also used by the Reticulum gateway). Go is a later option.
- **Drop-in web:** `<script src="https://subetha.us/sdk.js">` and `<subetha-feed topic="…">` /
  `<subetha-send topic="…">` web components.
- **CLI:** `npx subetha pub|sub|tail|route|cost|login`.
- **Agents:** remote MCP server, `llms.txt` / `llms-full.txt`, OpenAPI 3.1, stable machine-readable
  errors, idempotency keys, dry-run cost estimates, `wait_for_message` long-poll.
- **Built-in tools on the site:**
  - API explorer that runs live against your account (or a sandbox).
  - Message composer with "copy as curl / JS / Python / Swift / Kotlin / Dart".
  - Live topic tail, and a webhook/endpoint inspector.
  - **Route simulator**: "if I publish this, who gets it, how, and what does it cost?"
  - Token builder (scopes + caps → token + snippet), and the pricing calculator.
  - Message trace viewer.
- **Working code samples:** every docs snippet lives as a file under `docs/samples/` and runs in CI
  against `wrangler dev` (and nightly against staging). A broken sample fails the build.

### SDK architecture (decided)
- **Rust core** (`sdk/core`): envelope, canonicalization, signatures, E2EE, dedupe, store-and-forward
  queue, routing/escalation, policy evaluation, edge gossip protocol.
  - Swift and Kotlin bindings via **UniFFI**. Flutter via **flutter_rust_bridge**. React Native via
    **uniffi-bindgen-react-native**.
  - Platform shims provide BLE, audio, camera/QR, push tokens, and background execution.
- **TypeScript SDK** (`sdk/js`): hand-written and dependency-free so it stays small for web pages and
  scripts. It optionally loads core WASM for E2EE and edge features.
- **Conformance suite** (`spec/vectors`): every SDK must pass the same test vectors.

---

## 11. Web console (subetha.us/console)

- **Send / receive:** pick or create topics, compose (all ntfy fields + attachments), live inbox,
  and filter by tag or priority.
- **Devices:** enroll (QR / code), capabilities, last seen, revoke, and "this browser" as a device.
- **Endpoints:** add and verify email, phone, Slack, webhook, and LXMF endpoints.
- **Topics:** ownership, subscribers (aggregate), publish permissions, E2EE keys, retention.
- **Policies, tokens, billing** (balance, top-up, auto-recharge, ledger, invoices/receipts),
  **usage** charts by SKU, **traces**, and an **audit log**.
- The console is itself an SDK client, so it eats its own dog food.

---

## 12. Repository layout (monorepo)

```
/spec                 protocol spec, JSON Schema, OpenAPI, test vectors
/pricing              costs.yaml, fixed-costs.yaml, price generator, invariant tests
/workers
  /api                Hono API Worker (REST, ntfy-compat, SSE/WS upgrade)
  /durable            TopicDO, AccountDO, DeviceDO
  /delivery           Queue consumers per relay transport
  /email              inbound Email Worker
  /hooks              Stripe, Twilio, Slack, Clerk webhooks
  /mcp                remote MCP server
/gateways
  /reticulum          Python RNS/LXMF bridge (Container image)
/sdk
  /core               Rust core + UniFFI
  /js                 TypeScript SDK + web components + CLI
  /swift  /kotlin  /flutter  /react-native  /python
/apps
  /site               Astro site: marketing, docs (Starlight), console (React islands)
/samples
  /web  /ios  /android  /flutter  /react-native  /cli  /agent-mcp  /esp32 (later)
/docs                 docs content + runnable samples
/infra                wrangler.toml per env, Cloudflare DNS/zone config (Terraform), secrets manifest
/.github/workflows    CI, deploy, pages, release
```

Tooling: pnpm + Turborepo (TS), a Cargo workspace (Rust), Vitest +
`@cloudflare/vitest-pool-workers`, and Playwright for console E2E. Mobile CI uses GitHub macOS
runners (iOS) and Linux (Android / Flutter / RN).

---

## 13. Publishing: GitHub Pages and production

**GitHub Pages** (`curtcox.github.io/subetha`, optionally CNAME `dev.subetha.us`, see open question 2) holds:
- **Build info:** commit, version, CI status per package, test and coverage summaries, the
  **pricing invariant report** (every SKU's cost vs. price vs. margin), SDK versions, and a changelog.
- **Docs:** a versioned static docs build, mirroring what's on subetha.us.
- **Sample apps:** the live web sample, Flutter web and Expo web builds, Android APK downloads,
  iOS build instructions plus a TestFlight link, and source links.

**Production** (`subetha.us`) uses Cloudflare Workers with static assets, deployed by GitHub
Actions with `wrangler deploy` on tagged releases (staging deploys on every merge to `main`). D1
migrations run in the deploy job. Secrets live in GitHub Environments and are pushed with
`wrangler secret`.

---

## 14. Roadmap

All four transport groups (email/Slack/MCP, Twilio SMS/voice, Reticulum, BLE/audio/QR) are wanted
early, so the work after the core relay runs as **parallel tracks** instead of strict phases.
Anything with external lead time starts in Phase 0.

### Phase 0: Foundations (also starts long-lead items)
- Monorepo, CI, spec v0 + test vectors, GH Pages skeleton with build info, Cloudflare zone + staging.
- Pricing generator, `costs.yaml`, invariant tests.
- **Long-lead, start now:** business entity / Twilio account, **A2P 10DLC brand + campaign
  registration** (takes weeks), Apple Developer + Google Play accounts, Slack app registration,
  Stripe account + Radar rules, Clerk prod instance, Cloudflare Containers access.
- Exit: Pages site live, `pnpm test` + `cargo test` green, price table generated.

### Phase 1: Core relay MVP (critical path)
- ntfy-compatible publish/subscribe (HTTP, JSON, SSE, WS), TopicDO, D1 schema.
- Clerk login, API tokens, AccountDO ledger + credit leases, Stripe top-ups, 402 handling.
- Minimal console (send / receive / billing), TS SDK + CLI.
- Exit: `curl` publish → the browser console receives it; balance debits; property tests prove the
  balance never goes negative.

### Phase 2: Parallel tracks (start once Phase 1's API and ledger are stable)

| Track | Scope | Depends on | Exit criteria |
|---|---|---|---|
| **A. Control plane** | devicebasedauth enrollment, device signatures, policies, traces, dry-run, escalation engine, Web Push / APNs / FCM, webhooks | Phase 1 | Policy matrix tests; escalation chain E2E in staging |
| **B. Email + Slack + MCP** | Email in/out, Slack app (channel ↔ topic), remote MCP server (OAuth via Clerk) | Phase 1, A (policies) | Email → topic → Slack round trip; MCP `wait_for_message` works from an agent |
| **C. Twilio SMS/voice (US)** | SMS in/out, voice TTS + DTMF ack, verified numbers, new-funds holds, Twilio repricing Cron, SMS-pumping defenses | Phase 1, A, 10DLC approval | Alarm escalates WS → push → SMS → voice in staging; per-SKU margin positive in reconciliation |
| **D. Reticulum gateway** | Python RNS/LXMF bridge in Containers, topic ↔ LXMF destination mapping, BYO-gateway docs, Python SDK | Phase 1 | Sideband/NomadNet user ↔ web console round trip |
| **E. Rust core + mobile SDKs** | `sdk/core` (envelope, crypto, dedupe, store-and-forward, routing), UniFFI → Swift/Kotlin, flutter_rust_bridge, uniffi-bindgen-react-native, sample apps on all four platforms | spec v0 (can start in Phase 0) | Same sample app passes the scripted flow on iOS, Android, Flutter, RN |
| **F. Edge transports** | BLE store-and-forward, audio modem, animated QR, LAN discovery, E2EE, edge gossip | E | Offline phone gets a message via a BLE hop; audio and QR transfer demos in sample apps |
| **G. Docs + dev tools** | Starlight docs, live API explorer, route simulator, token builder, pricing calculator, tested samples, `llms.txt`, OpenAPI | Phase 1, then follows every track | Every docs sample runs in CI |

Track E has no server dependency, so it can start in Phase 0. That keeps Track F (edge transports)
from becoming the long pole.

### Phase 3: Launch hardening
Load tests, abuse/rate tuning, ToS / privacy / AUP (including SMS consent language), status page,
backups, security review, pricing review against real bills, then the production launch on
subetha.us.

## 15. Decisions and open questions

### Decided
| # | Topic | Decision |
|---|---|---|
| D1 | Free usage | **None** for relay or gateway actions. Only edge/local transports are free. |
| D2 | Who pays for delivery | **Topic owner** pays for fan-out and delivery; the publisher pays for the publish. |
| D3 | SDK architecture | **Rust core + bindings** (UniFFI, flutter_rust_bridge, uniffi-bindgen-react-native), plus a hand-written TS SDK for the web. |
| D4 | Early transports | **All of:** email + Slack + MCP, Twilio SMS/voice (US), Reticulum gateway, BLE/audio/QR edge, run as parallel tracks (§14). |
| D5 | Device auth (was open question 1) | **devicebasedauth.org replaces subetha's own enrollment** (2026-11-24). Devices enroll there for the first-party audience `subetha.us` (operator pays its online decisions and sign-ins); subetha verifies their device-bound credentials offline with the vendored `@devicebasedauth/verify` (`workers/api/src/dba.ts`). An account links one DBA account over OpenID Connect; that account's devices act as the account's devices within their grants (`subetha:publish`, `subetha:subscribe`, topics as resources). A DBA device may attach an Ed25519 key (E2EE, signed messages), stopped when its DBA credential is revoked. The device-code flow and direct registration answer 410. Humans still sign in with Clerk; "Sign in with devicebasedauth.org" for the console is DBA as a custom OIDC provider in subetha's Clerk app (`infra/secrets.md`). |

### Still open
1. ~~devicebasedauth.org~~: decided, D5.
2. **GitHub Pages domain:** `curtcox.github.io/subetha`, or a subdomain such as `dev.subetha.us`?
3. **Refunds:** can unused balance be refunded (minus processing fees), or is it non-refundable
   credit? This affects how Stripe fees are passed through.
4. **Code sharing with hashbin:** should SubEtha reuse hashbin.org's stack/modules (billing ledger,
   Clerk integration, docs tooling)? If so, please grant read access to `curtcox/hashbin.org` so
   the plan can match it.
5. **Entity and accounts:** is `subetha.us` already on Cloudflare? Is there a business entity for
   Twilio A2P 10DLC registration? Do Stripe, Clerk, Twilio, Apple, and Google developer accounts
   exist?
6. **Topic namespace:** global ntfy-style names (`subetha.us/anything`) in addition to
   `@handle/…` and `t_<random>`? Global names are friendlier but invite squatting and collisions.
