# Secrets and configuration manifest

Everything the Worker reads from its environment (`Env` in
[`workers/api/src/types.ts`](../workers/api/src/types.ts)). Every provider is optional: a Worker
without Twilio secrets simply has no SMS or voice, and `GET /v1/status` shows which transports are
configured.

- **Bindings** are declared in `workers/api/wrangler.jsonc` (see [`README.md`](README.md)).
- **Vars** are plain-text `vars` in `wrangler.jsonc`.
- **Secrets** are set per environment with `wrangler secret put NAME --env staging|production`,
  or by the deploy workflow from GitHub Environment secrets of the same name. Locally, put them in
  `workers/api/.dev.vars`.

Use test-mode credentials (Stripe test keys, a Twilio test or trial account, a Clerk development
instance, a separate Firebase project) for staging.

## Bindings

| Name | Type | Notes |
|---|---|---|
| `DB` | D1 | Accounts, tokens, topics, endpoints, subscriptions, devices, files, ledger journal. Migrations in `workers/api/migrations`. |
| `CACHE` | KV | Token/account cache, Slack OAuth state, telephony circuit breaker. |
| `FILES` | R2 | Attachments (`att/<id>`). Without it, `X-Filename` uploads return `unsupported`. |
| `TOPIC`, `ACCOUNT` | Durable Objects | `TopicDO` (fan-out, buffer, traces), `AccountDO` (balance ledger). |
| `DELIVERY` | Queue (producer + consumer) | Paid deliveries. Without it, only live transports work. |
| `ASSETS` | Static assets | `apps/site/public` (landing page, console, docs, `sdk.js`, `sw.js`). |
| `RL_AUTH`, `RL_ANON` | Rate Limiting | Per-credential and per-IP request limits. |
| `EMAIL` | `send_email` (optional) | Cloudflare Email Service for outbound email; when absent, SES is used. |

## Vars

| Name | Values | Notes |
|---|---|---|
| `ENVIRONMENT` | `local`, `staging`, `production` | Set per environment in `wrangler.jsonc`. |
| `BASE_URL` | `http://localhost:8787`, `https://staging.subetha.us`, `https://subetha.us` | Used in links, OAuth redirects, attachment URLs, and Twilio signature checks. |
| `DEV_BOOTSTRAP_SECRET` | `local-dev-only` | **Local only.** Enables `POST /v1/dev/bootstrap` when `ENVIRONMENT=local`. Never set it for staging or production. |

## Secrets

### Auth (Clerk)

| Name | Where to get it |
|---|---|
| `CLERK_ISSUER` | Clerk dashboard → API Keys → "Frontend API URL" (e.g. `https://clerk.subetha.us`). Also advertised as the MCP authorization server. |
| `CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys → Publishable key (`pk_live_…` / `pk_test_…`). Not secret; served by `GET /v1/config` to the console. |
| `CLERK_JWKS_URL` | `<issuer>/.well-known/jwks.json`. |
| `CLERK_AUTHORIZED_PARTIES` | Comma-separated origins allowed as the JWT `azp`, e.g. `https://subetha.us`. |
| `CLERK_WEBHOOK_SECRET` | Optional. Clerk dashboard → Webhooks → endpoint `https://<host>/v1/hooks/clerk` (`user.updated`, `user.deleted`, `organization.deleted`) → Signing Secret (`whsec_…`). |
| `CLERK_JWKS` | Inline JWKS JSON. Tests and local development only. |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | Optional. Credentials the relay uses to introspect **opaque** OAuth access tokens (RFC 7662) from MCP clients. Create them for the relay in Clerk (Configure → OAuth applications). Without them, only JWT access tokens are accepted. |
| `OAUTH_INTROSPECTION_URL` | Optional. Defaults to `<CLERK_ISSUER>/oauth/token_info`. |

For "Sign in with OAuth" in MCP clients, also enable dynamic client registration for OAuth
applications in the Clerk dashboard, so clients can register themselves.

### Payments (Stripe)

| Name | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys → Secret key (`sk_live_…`; `sk_test_…` for staging). A restricted key with Checkout Sessions write is enough. |
| `STRIPE_WEBHOOK_SECRET` | Developers → Webhooks → add endpoint `https://<host>/v1/hooks/stripe` for `checkout.session.completed`, `charge.refunded`, `charge.dispute.created` → Signing secret (`whsec_…`). |

### Web Push

| Name | Where to get it |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `node workers/api/scripts/vapid-keys.mjs`. Keep them stable: changing them invalidates every browser subscription. |
| `VAPID_SUBJECT` | A contact URL for push services: `mailto:ops@subetha.us` or `https://subetha.us`. |

### FCM

| Name | Where to get it |
|---|---|
| `FCM_SERVICE_ACCOUNT` | Firebase console → Project settings → Service accounts → Generate new private key. The whole JSON file as one value. |

### APNs

| Name | Where to get it |
|---|---|
| `APNS_KEY_P8` | Apple Developer → Certificates, IDs & Profiles → Keys → new key with APNs → download the `.p8` (PEM text). |
| `APNS_KEY_ID` | The key's 10-character Key ID. |
| `APNS_TEAM_ID` | Apple Developer → Membership → Team ID. |
| `APNS_TOPIC` | The iOS app's bundle id. |
| `APNS_ENDPOINT` | Optional. Default `https://api.push.apple.com`. APNs requires HTTP/2, which a Worker's `fetch()` may not negotiate: run [`gateways/apns-relay`](../gateways/apns-relay/README.md) and set this to its URL (e.g. `https://apns-relay.subetha.us`), or use FCM for iOS. |
| `APNS_RELAY_SECRET` | With the relay: the same random value as its `RELAY_SECRET` (at least 16 characters), sent as `x-relay-secret`. |

### Slack

| Name | Where to get it |
|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | api.slack.com/apps → your app → Basic Information → App Credentials. Redirect URL: `https://<host>/v1/slack/oauth`. Bot scopes: `chat:write`, `channels:history`, `groups:history`, `channels:read`. |
| `SLACK_SIGNING_SECRET` | Same page → Signing Secret. Event Subscriptions request URL: `https://<host>/v1/hooks/slack/events` (events `message.channels`, `message.groups`). |
| `SLACK_BOT_TOKEN` | Optional fallback bot token (`xoxb-…`) for Slack endpoints created without an OAuth install. |

### Twilio (SMS and voice, US)

| Name | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio console → Account Info. The auth token also verifies inbound webhook signatures. |
| `TWILIO_FROM` | A Twilio US number in E.164 (`+1…`), registered to an approved **A2P 10DLC** campaign (PLAN §14 Phase 0: takes weeks). Set its "A message comes in" webhook to `https://<host>/v1/hooks/twilio/sms` (POST). |
| `TWILIO_API_BASE` | Optional. Leave unset in staging and production; the E2E tests set it to a local mock Twilio. |

### Email

| Name | Where to get it |
|---|---|
| `EMAIL_FROM` | Sender, e.g. `SubEtha <notify@subetha.us>`. The domain needs SPF/DKIM/DMARC for the sending provider. |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | AWS IAM user with `ses:SendEmail` only. Not needed when the `EMAIL` binding (Cloudflare Email Service) is configured. |
| `SES_REGION` | The SES region with the verified domain (default `us-east-1`). |
| `INBOUND_EMAIL_DOMAIN` | `in.subetha.us` (`in.staging.subetha.us` for staging); must match the Email Routing setup in `cloudflare-zone.md`. |

### Reticulum / LXMF

| Name | Where to get it |
|---|---|
| `LXMF_GATEWAY_URL` | Base URL of the hosted Reticulum gateway (`gateways/reticulum`), which serves `POST /deliver`. |
| `LXMF_GATEWAY_SECRET` | A random string (`openssl rand -hex 32`); the same value goes in the gateway's config to verify `X-SubEtha-Signature`. |

### Reserved

| Name | Notes |
|---|---|
| `WEBHOOK_SIGNING_SECRET` | Declared in `Env` but not currently read: each webhook endpoint gets its own secret. |

## GitHub Actions secrets (not Worker secrets)

| Name | Where | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Environments `staging`, `production` | See `README.md` for the permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | Environments `staging`, `production` | Cloudflare dashboard → Account ID. |
| `SAMPLES_TOKEN` | Environment `staging` | Admin API token for a dedicated account (e.g. handle `samples`, a few dollars of balance) used by `nightly.yml` to run the docs samples against staging. Optional variables: `STAGING_URL`, `SAMPLES_TOPIC`. |

Repository variables (optional): `PAGES_BASE_PATH`, `PAGES_URL`, `APP_URL` for `pages.yml`.
