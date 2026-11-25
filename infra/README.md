# Infrastructure

SubEtha runs as one Cloudflare Worker (`workers/api`) with Durable Objects, D1, KV, R2, a Queue,
Rate Limiting bindings, Cron Triggers, Email Routing, and static assets (`apps/site/public`).
Everything is declared in [`workers/api/wrangler.jsonc`](../workers/api/wrangler.jsonc), with the
top level for local development and `env.staging` / `env.production` for the deployed
environments (PLAN §7, §13).

| File | What |
|---|---|
| [`secrets.md`](secrets.md) | Every binding, variable, and secret the Worker reads, and where to get each |
| [`cloudflare-zone.md`](cloudflare-zone.md) | DNS, custom domains, Email Routing, and zone settings for `subetha.us` |
| [`terraform/`](terraform/README.md) | Terraform configuration for the Cloudflare zone, DNS, Email Routing, and D1/KV/R2/Queues bindings |
| [`../.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Staging on push to `main`, production on `v*` tags |
| [`../.github/workflows/pages.yml`](../.github/workflows/pages.yml) | GitHub Pages: docs, build info, pricing report |

Use [`infra/terraform/`](terraform/README.md) to provision the zone settings and Cloudflare bindings
declaratively, or run the `wrangler` commands below by hand.

## One-time setup per environment

You need a Cloudflare account on the Workers Paid plan (Durable Objects with SQLite, Queues), the
`subetha.us` zone on that account, and `wrangler` (`pnpm install` provides it; run the commands
below from `workers/api`, e.g. `pnpm --filter @subetha/api exec wrangler …`, after
`wrangler login`).

Replace `staging` with `production` for the production environment.

```bash
cd workers/api

# D1 (prints database_id)
npx wrangler d1 create subetha-staging

# KV for the token/policy cache (prints id)
npx wrangler kv namespace create subetha-cache-staging

# R2 for attachments, and a separate private bucket for nightly D1 backups
npx wrangler r2 bucket create subetha-files-staging
npx wrangler r2 bucket create subetha-backups-staging

# Queues for paid deliveries, plus the dead-letter queue
npx wrangler queues create subetha-delivery-staging
npx wrangler queues create subetha-delivery-dlq-staging
```

Then put the printed ids into `workers/api/wrangler.jsonc` under that environment. Both
environments' ids are already there (staging was provisioned and first deployed by hand on
2026-11-25). A new environment starts from the placeholders `REPLACE_WITH_<ENV>_D1_ID` (the
`database_id`) and `REPLACE_WITH_<ENV>_KV_ID` (the KV `id`).

These ids aren't secret; commit them. The deploy workflow skips an environment (with a warning)
while its placeholders are still there.

Other bindings need no creation step:

- **Durable Objects** (`TopicDO`, `AccountDO`) are created by the first deploy (migration tag `v1`).
- **Rate limits** (`RL_AUTH` 600/min per credential, `RL_ANON` 60/min per IP) use
  `namespace_id`s `3001`/`3002` in production and `3003`/`3004` in staging, so staging load
  tests don't use up production's limits. These must be unique among rate-limit bindings in the
  Cloudflare account (another Worker there uses `1001`), so change them if they collide.
- **Cron**: `17 3 * * *` (daily rent metering, freeze/cleanup, Stripe reconciliation, Twilio price
  check, expired-attachment cleanup).
- **Custom domains** (`staging.subetha.us`; `subetha.us` and `mcp.subetha.us` for production)
  are attached by `wrangler deploy` because the routes use `custom_domain: true`.
- **Outbound email**: to use Cloudflare Email Service instead of SES, add a `send_email` binding
  named `EMAIL` to the environment (see `cloudflare-zone.md`).
- **Inbound email**: an Email Routing rule, set up in the dashboard (see `cloudflare-zone.md`).

Apply the database schema and deploy once by hand, or let the workflow do it:

```bash
npx wrangler d1 migrations apply DB --env staging --remote
pnpm --filter @subetha/sdk build && pnpm --filter @subetha/site build   # static assets
npx wrangler deploy --env staging
curl https://staging.subetha.us/v1/health
curl https://staging.subetha.us/v1/status   # which transports are configured
```

## GitHub configuration

1. Create the GitHub Environments **`staging`** and **`production`** (Settings → Environments).
   Protect `production` with required reviewers and restrict it to `v*` tags.
2. In each environment, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`:
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard → Workers & Pages → Account ID (right sidebar).
   - `CLOUDFLARE_API_TOKEN`: My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"
     template, plus **Account › D1 › Edit**, **Account › Queues › Edit**,
     **Account › Workers R2 Storage › Edit**, **Account › Workers KV Storage › Edit**, and
     **Zone › Workers Routes › Edit** and **Zone › DNS › Edit** for `subetha.us` (custom domains).
3. Add whichever Worker secrets from [`secrets.md`](secrets.md) the environment should have.
   The deploy job pushes every one that is set with `wrangler secret bulk`; unset ones are left
   alone (so secrets put by hand with `wrangler secret put` survive).
4. For Pages: Settings → Pages → Source: **GitHub Actions**. For a custom domain (PLAN open
   question 2), set the repository variables `PAGES_BASE_PATH=/` and `PAGES_URL=https://dev.subetha.us`
   and add the CNAME in Pages settings.

## Deploying

- **Staging**: every push to `main` runs `deploy.yml`: typecheck and tests, build `sdk.js` and the
  docs into `apps/site/public`, `wrangler d1 migrations apply --remote`, `wrangler deploy --env staging`,
  push secrets, then a health check.
- **Production**: push a tag, e.g. `git tag v0.1.0 && git push origin v0.1.0`. Same steps with
  `--env production`, gated by the `production` environment's protection rules.

Migrations run before the new code is deployed, so they must be backward compatible with the
running version (add columns and tables; don't rename or drop in the same release).

## Backups and restore

Two layers protect D1, which holds everything except live Durable Object state:

1. **D1 Time Travel** (built in, 30 days): point-in-time restore of the whole database.
   `npx wrangler d1 time-travel restore subetha-production --timestamp <unix or RFC 3339>`
2. **Nightly logical backups** (`workers/api/src/backup.ts`, run by the 03:17 UTC cron) to the
   `BACKUPS` bucket. Each day `d1/<YYYY-MM-DD>/` holds one gzip'd NDJSON file per table and
   a `manifest.json` (schema, row counts, SHA-256 of every file). Days older than
   `BACKUP_RETENTION_DAYS` (default 35) are pruned. These survive deleting the database or
   the account it's in, and they're portable to plain SQLite.

Balances live in each account's Durable Object, but every ledger entry is journaled to D1's
`ledger_journal` with `available_after` and `reserved_after`, so the newest row per account
restores its balance. The backup bucket contains personal data (emails, phone numbers): keep it
private, and limit the API tokens that can read it.

To restore a nightly backup into a new, empty database:

```bash
node --experimental-strip-types scripts/restore-d1.mjs --bucket subetha-backups-production --day 2026-11-22 --out restore.sql
npx wrangler d1 create subetha-production-restore
npx wrangler d1 execute subetha-production-restore --remote --file restore.sql
```

The script checks every file's hash before writing SQL. Point `wrangler.jsonc` at the new
`database_id` and deploy, then rehydrate the account Durable Objects from `ledger_journal` if
they were lost too. Run a restore drill against staging once a quarter.

## Local development

```bash
pnpm install
pnpm --filter @subetha/sdk build && pnpm --filter @subetha/site build
pnpm --filter @subetha/api exec wrangler d1 migrations apply DB --local
pnpm --filter @subetha/api dev     # http://localhost:8787
curl -X POST localhost:8787/v1/dev/bootstrap -d '{"secret":"local-dev-only","handle":"me","credit_usd":5}'
```

Local secrets go in `workers/api/.dev.vars` (gitignored), one `NAME=value` per line.

## Load testing

`scripts/loadtest.mjs` opens S subscriber streams on one topic, then P publishers send N messages
each, and reports publish and publish→receive latency. Every message is charged to the token's
account. API tokens are limited to 600 requests a minute (`RL_AUTH`), and subscriber connections
count toward that, so keep `S + P×N` under 600 per token per minute, or use several tokens.

Local baseline (`wrangler dev` on one machine, November 2026), all deliveries received:

| Subscribers | Publishers × messages | Publish p50 / p95 | Delivery p50 / p95 |
|---|---|---|---|
| 20 | 5 × 40 | 66 / 80 ms | 70 / 106 ms |
| 100 | 10 × 30 | 119 / 182 ms | 195 / 289 ms |

Run the same against staging before launch (PLAN §14 Phase 3):

```bash
SUBETHA_URL=https://staging.subetha.us SUBETHA_TOKEN=se_… node scripts/loadtest.mjs --topic @me/load --subscribers 100 --publishers 10 --messages 30
```
