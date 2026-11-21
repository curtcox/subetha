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
- **Control plane** (`/v1/*`): accounts (Clerk), Stripe Checkout top-ups and webhooks, scoped and
  capped API tokens (including origin-bound publishable tokens), topic policies, traces, dry runs,
  idempotency keys, endpoints with verification codes, subscriptions with escalation, device
  enrollment (device-code flow and request signatures), `/v1/status`.
- **Transports**: live WS/SSE/poll; Web Push, FCM, APNs; HMAC-signed webhooks; email out
  (Cloudflare Email Service or SES) and in (Email Routing); Slack (OAuth install, both
  directions); Twilio SMS and voice (US, with STOP/HELP/ACK and DTMF ack); remote MCP server at
  `/mcp`; Reticulum/LXMF through the gateway.
- **SDKs**: TypeScript SDK + CLI + web components (`sdk/js`), Python SDK (`sdk/python`), Rust core
  with edge-transport protocol logic and UniFFI-shaped bindings (`sdk/core`). All pass the shared
  conformance vectors in `spec/vectors`.
- **Gateway**: Reticulum/LXMF bridge (`gateways/reticulum`), Docker image included.
- **Pricing**: generated price table with margin invariants enforced in CI (`pricing/`).
- **Docs and tooling**: developer docs with CI-tested samples (`docs/`), OpenAPI 3.1 with a drift
  test (`spec/openapi.yaml`), `llms.txt`, web console (`apps/site/public/console`), GitHub Pages
  and deploy workflows, infrastructure notes (`infra/`), legal drafts (`docs/legal/`).

## Repository layout

```
spec/             protocol spec, JSON Schema, errors.json, OpenAPI 3.1, conformance vectors (+ tests)
pricing/          costs.yaml, fixed-costs.yaml, price generator, invariant tests, generated/ report
workers/api/      the relay Worker: src/ (Hono app, Durable Objects, delivery senders, MCP, devices,
                  cron, inbound email), migrations/ (D1), test/ (Miniflare tests), wrangler.jsonc
sdk/js/           TypeScript SDK, CLI (`subetha`), web components (sdk.js), Web Push helper
sdk/python/       Python SDK
sdk/core/         Rust core (protocol, store-and-forward, routing, edge transports, FFI)
gateways/reticulum/  Python Reticulum/LXMF gateway
apps/site/        landing page, web console, service worker, docs builder (build.mjs)
docs/             developer docs (Markdown), samples/ (runnable, CI-tested), legal/ (drafts)
infra/            Cloudflare setup, secrets manifest, zone notes
scripts/          file-size check, load test
.github/workflows ci.yml, pages.yml, deploy.yml, file-size-check.yml
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
| **A** Control plane | Mostly done | Device enrollment (device-code) + request signatures, policies, traces, dry runs, escalation, Web Push / APNs / FCM, webhooks | devicebasedauth.org (open question 1); APNs HTTP/2 path; escalation E2E in staging |
| **B** Email + Slack + MCP | Mostly done | Email in/out, Slack app both ways, MCP server with protected-resource metadata | MCP OAuth flow via Clerk (bearer tokens work today); staging round trip |
| **C** Twilio SMS/voice | Code done, blocked | SMS in/out, voice + DTMF ack, verified US numbers, STOP/HELP, new-funds hold, Twilio price check + circuit breaker | A2P 10DLC approval; live per-destination repricing; staging escalation test |
| **D** Reticulum gateway | Mostly done | Gateway (both directions, `/deliver` for LXMF endpoints), Docker, Python SDK, BYO-gateway docs | Hosted deployment (Containers or VPS); Sideband round trip |
| **E** Rust core + mobile SDKs | In progress | Rust core passing all vectors, UniFFI-shaped FFI | Swift/Kotlin/Flutter/RN bindings and sample apps |
| **F** Edge transports | In progress | Protocol logic in the core: audio modem, fountain-coded QR, BLE chunking, gossip | Platform shims (BLE, audio, camera), demos |
| **G** Docs + dev tools | Partly done | Docs with CI-run samples, OpenAPI + drift test, llms.txt, static docs build | API explorer, route simulator, token builder, pricing calculator; nightly samples against staging |
| **Phase 3** Launch hardening | Started | Rate limits, load-test script, legal drafts, `/v1/status` | Load tests, abuse tuning, legal review, status page, backups, security review |

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
