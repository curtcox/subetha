# subetha

Messaging platform: send and receive ntfy-style messages between any devices over any
transport (IP, push, email, Slack, SMS/voice, MCP, Reticulum, Bluetooth, audio, QR/video),
without devices needing to know about each other or how messages are relayed.

Production: https://subetha.org · Docs: [`docs/`](docs/index.md) (published at
https://subetha.org/docs/ and https://curtcox.github.io/subetha/) · Build info and pricing
report: https://curtcox.github.io/subetha/build-info.html

See [PLAN.md](PLAN.md) for the project plan and open questions.

```bash
curl -H "Authorization: Bearer $SUBETHA_TOKEN" -d "Backup done" https://subetha.org/@me/backups
curl -H "Authorization: Bearer $SUBETHA_TOKEN" https://subetha.org/@me/backups/json   # stream
```

## What's implemented

- **Relay** (`workers/api`): one Cloudflare Worker with ntfy-compatible publish (headers, query
  string, JSON, `X-Filename` attachments to R2) and subscribe (NDJSON, SSE, raw, WebSocket, poll,
  `since`, filters, several topics), a `TopicDO` per topic (fan-out, buffer, traces, acks) and an
  `AccountDO` per account (prepaid ledger, credit leases, caps, new-funds hold), D1, KV, Queues,
  rate limits, and a daily cron for rent metering, freezing, reconciliation, and Twilio price checks.
- **Control plane** (`/v1/*`): accounts (Clerk), Stripe Checkout top-ups (and opt-in auto-recharge) and webhooks, scoped and
  capped API tokens (including origin-bound publishable tokens), topic policies, traces, dry runs,
  idempotency keys, endpoints with verification codes, subscriptions with escalation, device
  enrollment (device-code flow and request signatures), an audit log, `/v1/status`.
- **Transports**: live WS/SSE/poll; Web Push, FCM, APNs; HMAC-signed webhooks; email out
  (Cloudflare Email Service or SES) and in (Email Routing); Slack (OAuth install, both
  directions); Twilio SMS and voice (US, with STOP/HELP/ACK and DTMF ack); remote MCP server at
  `/mcp` (API tokens, or OAuth access tokens from Clerk with a per-client spend cap);
  Reticulum/LXMF through the gateway.
- **SDKs**: TypeScript SDK + CLI + web components (`sdk/js`), Python SDK (`sdk/python`), Rust core
  with edge-transport protocol logic and UniFFI bindings (`sdk/core`), Swift (`sdk/swift`), Kotlin
  (`sdk/kotlin`), Dart/Flutter (`sdk/flutter`), and React Native (`sdk/react-native`). All pass the
  shared conformance vectors in `spec/vectors`. Doorbell sample apps for web, CLI, agents, Python,
  iOS, Android, Flutter, and React Native (`samples/`).
- **Gateways**: Reticulum/LXMF bridge (`gateways/reticulum`) and an HTTP/1.1 → HTTP/2 APNs relay
  (`gateways/apns-relay`), each with a Docker image.
- **Pricing**: generated price table with margin invariants enforced in CI (`pricing/`).
- **Docs and tooling**: developer docs with CI-tested samples (`docs/`), OpenAPI 3.1 with a drift
  test (`spec/openapi.yaml`), `llms.txt`, GitHub Pages and deploy workflows, infrastructure notes
  (`infra/`), legal drafts (`docs/legal/`).
- **Web console and tools** (`apps/site`): the console (send/receive, topics, endpoints and
  escalation subscriptions, Slack, devices, tokens, billing, usage chart and limits, traces, audit log, and an
  OpenAPI-driven API explorer; "copy as" curl/JS/Python/Swift/Kotlin/Dart), plus a pricing
  calculator and an offline route simulator at `/tools/` that bundle the relay's own price table
  and planner, and the Edge lab (sound, animated QR, and Bluetooth between nearby browsers).

## Repository layout

```
spec/             protocol spec, JSON Schema, errors.json, OpenAPI 3.1, conformance vectors (+ tests)
pricing/          costs.yaml, fixed-costs.yaml, price generator, invariant tests, generated/ report
workers/api/      the relay Worker: src/ (Hono app, Durable Objects, delivery senders, MCP, devices,
                  cron, inbound email), migrations/ (D1), test/ (Miniflare tests), wrangler.jsonc
sdk/js/           TypeScript SDK, CLI (`subetha`), web components (sdk.js), Web Push helper
sdk/python/       Python SDK
sdk/core/         Rust core (protocol, store-and-forward, routing, edge transports, FFI)
sdk/swift/ sdk/kotlin/ sdk/flutter/ sdk/react-native/   mobile SDKs (see sdk/core/BINDINGS.md)
gateways/reticulum/  Python Reticulum/LXMF gateway
gateways/apns-relay/ HTTP/1.1 → HTTP/2 relay for APNs (Node, no dependencies)
apps/site/        landing page, web console, tools (src/ → tools.js), docs builder (build.mjs)
docs/             developer docs (Markdown), samples/ (runnable, CI-tested), legal/ (drafts)
infra/            Cloudflare setup, secrets manifest, zone notes
scripts/          file-size check, load test, D1 restore from nightly backups
.github/workflows ci.yml, mobile.yml, pages.yml, deploy.yml, nightly.yml, file-size-check.yml
```

## Tests

```bash
pnpm install
pnpm -r typecheck
pnpm -r test                 # spec, pricing, TS SDK, relay (Miniflare), docs samples
cargo test --workspace       # Rust core (+ builds the Rust docs sample)
pip install -e "sdk/python[test]" -e "gateways/reticulum[test]"
pytest sdk/python gateways/reticulum
```

`pnpm vectors` and `pnpm pricing` regenerate the conformance vectors and the price table; CI
fails if the committed copies are stale.

## Local development

```bash
pnpm install
pnpm --filter @subetha/sdk build     # builds sdk.js into apps/site/public
pnpm --filter @subetha/site build    # docs, llms.txt, openapi.yaml into apps/site/public
pnpm --filter @subetha/api exec wrangler d1 migrations apply DB --local
pnpm --filter @subetha/api dev       # wrangler dev on http://localhost:8787

curl -X POST localhost:8787/v1/dev/bootstrap -d '{"secret":"local-dev-only","handle":"me","credit_usd":5}'
# → {"account_id":"…","handle":"me","token":"se_…"}
curl -H "Authorization: Bearer se_…" -d "hello" localhost:8787/@me/test
```

Open http://localhost:8787/console/ and sign in with the token. Provider secrets for local testing
go in `workers/api/.dev.vars` (see [`infra/secrets.md`](infra/secrets.md)). Deploying:
[`infra/README.md`](infra/README.md).

## Status

Against the roadmap in [PLAN.md §14](PLAN.md#14-roadmap). "Done" means implemented and tested
in this repository; nothing is deployed to staging or production yet.

| Phase / track | Status | Done | Remaining |
|---|---|---|---|
| **Phase 0** Foundations | Mostly done | Monorepo, CI, spec v0 + vectors, pricing generator + invariants, Pages workflow with build info | Provision the Cloudflare zone and staging; long-lead accounts (10DLC, Apple/Google, Slack, Stripe, Clerk prod) |
| **Phase 1** Core relay MVP | Done (code) | ntfy publish/subscribe (HTTP, JSON, SSE, WS), TopicDO, D1, Clerk, tokens, ledger + leases, Stripe top-ups, 402s, console, TS SDK + CLI, ledger property tests | Staging verification of the exit criteria |
| **A** Control plane | Mostly done | Device enrollment (device-code) + request signatures, policies, traces, dry runs, escalation, Web Push / APNs (via the HTTP/2 relay) / FCM, webhooks, audit log | devicebasedauth.org (open question 1); escalation E2E in staging |
| **B** Email + Slack + MCP | Mostly done | Email in/out, Slack app both ways, MCP server with API tokens or OAuth access tokens (Clerk as authorization server; JWT or introspected) | Clerk OAuth app + dynamic client registration setup; staging round trip from a real MCP client |
| **C** Twilio SMS/voice | Code done, blocked | SMS in/out, voice + DTMF ack, verified US numbers, STOP/HELP, new-funds hold, Twilio price check + circuit breaker | A2P 10DLC approval; live per-destination repricing; staging escalation test |
| **D** Reticulum gateway | Mostly done | Gateway (both directions, `/deliver` for LXMF endpoints), Docker, Python SDK, BYO-gateway docs | Hosted deployment (Containers or VPS); Sideband round trip |
| **E** Rust core + mobile SDKs | Mostly done | Rust core passing all vectors; UniFFI bindings; Swift, Kotlin, Dart, and React Native SDKs; doorbell sample apps on all four platforms; mobile CI | flutter_rust_bridge plugin for the core in Flutter; running the scripted flow on devices |
| **F** Edge transports | In progress | Protocol logic in the core and the TS SDK (audio modem, fountain-coded QR, BLE chunking, gossip; spec §11 + shared vectors); browser shims (Web Audio, animated QR with a built-in QR encoder, Web Bluetooth central) and the Edge lab at `/tools/edge.html` | Native shims (BLE peripheral, audio, camera) in the mobile SDKs; offline BLE-hop demo on phones; LAN discovery |
| **G** Docs + dev tools | Mostly done | Docs with CI-run samples, OpenAPI + drift test, llms.txt, static docs build; pricing calculator, route simulator, token builder, API explorer, copy-as for six languages, trace viewer, usage by category (`/v1/usage` + chart), nightly samples-against-staging workflow | Set `SAMPLES_TOKEN` in the staging environment once staging exists |
| **Phase 3** Launch hardening | Started | Rate limits, load-test script, legal drafts, `/v1/status` and a status page (`/status/`, also on Pages so it works when the Worker is down), nightly D1 backups to R2 with a verified restore script | Load tests, abuse tuning, legal review, security review, restore drill in staging |

## File size limits

Pushes are checked so large files don't end up in the repository's history.
Every file added or changed by the commits being pushed must be under a
limit based on its type:

| Type | Examples | Limit |
| --- | --- | --- |
| SVG | `.svg` | 200 KB |
| Source / text / config | `.py` `.js` `.md` `.yml` `Makefile` … | 500 KB |
| Images | `.png` `.jpg` `.gif` `.webp` … | 1 MB |
| Fonts | `.woff2` `.ttf` `.otf` … | 1 MB |
| Data | `.csv` `.json` `.xml` `.sql` … | 2 MB |
| Lockfiles | `package-lock.json` `yarn.lock` `Cargo.lock` … | 2 MB |
| Documents | `.pdf` `.docx` `.pptx` `.xlsx` … | 5 MB |
| Archives / binaries | `.zip` `.tar.gz` `.jar` `.exe` `.so` `.wasm` … | 5 MB |
| Audio / video | `.mp3` `.wav` `.mp4` `.mov` `.webm` … | 10 MB |
| Anything else | | 1 MB |

Run `scripts/check-file-sizes.sh --list-defaults` for the full list.

The check runs in two places:

- **Locally, before each push.** Enable the hook once per clone:

  ```bash
  git config core.hooksPath .githooks
  ```

- **In CI** (`.github/workflows/file-size-check.yml`), on every push and pull
  request, so files pushed without the hook (or with `--no-verify`) are
  caught too.

To commit a file that legitimately exceeds its limit, add an entry to
[`.filesize-allow`](.filesize-allow) (for example `assets/hero.png 3MB`) and
commit it. Only the committed allowlist counts, so exceptions get reviewed.

You can also run the check by hand:

```bash
scripts/check-file-sizes.sh --range origin/main..HEAD   # commits not yet on main
scripts/check-file-sizes.sh --tree                      # every file at HEAD
```
