# Infrastructure

SubEtha runs as one Cloudflare Worker (`workers/api`) with Durable Objects, D1, KV, R2, a Queue,
Rate Limiting bindings, Cron Triggers, Email Routing, and static assets (`apps/site/public`).
Everything is declared in [`workers/api/wrangler.jsonc`](../workers/api/wrangler.jsonc), with the
top level for local development and `env.staging` / `env.production` for the deployed
environments (PLAN §7, §13).

| File | What |
|---|---|
| [`secrets.md`](secrets.md) | Every binding, variable, and secret the Worker reads, and where to get each |
| [`cloudflare-zone.md`](cloudflare-zone.md) | DNS, custom domains, Email Routing, and zone settings for `subetha.org` |
| [`../.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Staging on push to `main`, production on `v*` tags |
| [`../.github/workflows/pages.yml`](../.github/workflows/pages.yml) | GitHub Pages: docs, build info, pricing report |

Terraform for the zone is not set up yet; the zone settings are short enough to apply by hand
from `cloudflare-zone.md`.

## One-time setup per environment

You need a Cloudflare account on the Workers Paid plan (Durable Objects with SQLite, Queues), the
`subetha.org` zone on that account, and `wrangler` (`pnpm install` provides it; run the commands
below from `workers/api`, e.g. `pnpm --filter @subetha/api exec wrangler …`, after
`wrangler login`).

Replace `staging` with `production` for the production environment.

```bash
cd workers/api

# D1 (prints database_id)
npx wrangler d1 create subetha-staging

# KV for the token/policy cache (prints id)
npx wrangler kv namespace create subetha-cache-staging

# R2 for attachments
npx wrangler r2 bucket create subetha-files-staging

# Queues for paid deliveries, plus the dead-letter queue
npx wrangler queues create subetha-delivery-staging
npx wrangler queues create subetha-delivery-dlq-staging
```

Then put the printed ids into `workers/api/wrangler.jsonc` under `env.staging`:

| Placeholder | Value |
|---|---|
| `REPLACE_WITH_STAGING_D1_ID` | `database_id` from `wrangler d1 create subetha-staging` |
| `REPLACE_WITH_STAGING_KV_ID` | `id` from `wrangler kv namespace create subetha-cache-staging` |
| `REPLACE_WITH_PRODUCTION_D1_ID` | `database_id` from `wrangler d1 create subetha-production` |
| `REPLACE_WITH_PRODUCTION_KV_ID` | `id` from `wrangler kv namespace create subetha-cache-production` |

These ids aren't secret; commit them. The deploy workflow skips an environment (with a warning)
while its placeholders are still there.

Other bindings need no creation step:

- **Durable Objects** (`TopicDO`, `AccountDO`) are created by the first deploy (migration tag `v1`).
- **Rate limits** (`RL_AUTH` 600/min per credential, `RL_ANON` 60/min per IP) use
  `namespace_id`s `1001`/`1002`; these must be unique among rate-limit bindings in the account,
  so change them if another Worker already uses them.
- **Cron**: `17 3 * * *` (daily rent metering, freeze/cleanup, Stripe reconciliation, Twilio price
  check, expired-attachment cleanup).
- **Custom domains** (`staging.subetha.org`; `subetha.org` and `mcp.subetha.org` for production)
  are attached by `wrangler deploy` because the routes use `custom_domain: true`.
- **Outbound email**: to use Cloudflare Email Service instead of SES, add a `send_email` binding
  named `EMAIL` to the environment (see `cloudflare-zone.md`).
- **Inbound email**: an Email Routing rule, set up in the dashboard (see `cloudflare-zone.md`).

Apply the database schema and deploy once by hand, or let the workflow do it:

```bash
npx wrangler d1 migrations apply DB --env staging --remote
pnpm --filter @subetha/sdk build && pnpm --filter @subetha/site build   # static assets
npx wrangler deploy --env staging
curl https://staging.subetha.org/v1/health
curl https://staging.subetha.org/v1/status   # which transports are configured
```

## GitHub configuration

1. Create the GitHub Environments **`staging`** and **`production`** (Settings → Environments).
   Protect `production` with required reviewers and restrict it to `v*` tags.
2. In each environment, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`:
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard → Workers & Pages → Account ID (right sidebar).
   - `CLOUDFLARE_API_TOKEN`: My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"
     template, plus **Account › D1 › Edit**, **Account › Queues › Edit**,
     **Account › Workers R2 Storage › Edit**, **Account › Workers KV Storage › Edit**, and
     **Zone › Workers Routes › Edit** and **Zone › DNS › Edit** for `subetha.org` (custom domains).
3. Add whichever Worker secrets from [`secrets.md`](secrets.md) the environment should have.
   The deploy job pushes every one that is set with `wrangler secret bulk`; unset ones are left
   alone (so secrets put by hand with `wrangler secret put` survive).
4. For Pages: Settings → Pages → Source: **GitHub Actions**. For a custom domain (PLAN open
   question 2), set the repository variables `PAGES_BASE_PATH=/` and `PAGES_URL=https://dev.subetha.org`
   and add the CNAME in Pages settings.

## Deploying

- **Staging**: every push to `main` runs `deploy.yml`: typecheck and tests, build `sdk.js` and the
  docs into `apps/site/public`, `wrangler d1 migrations apply --remote`, `wrangler deploy --env staging`,
  push secrets, then a health check.
- **Production**: push a tag, e.g. `git tag v0.1.0 && git push origin v0.1.0`. Same steps with
  `--env production`, gated by the `production` environment's protection rules.

Migrations run before the new code is deployed, so they must be backward compatible with the
running version (add columns and tables; don't rename or drop in the same release).

## Local development

```bash
pnpm install
pnpm --filter @subetha/sdk build && pnpm --filter @subetha/site build
pnpm --filter @subetha/api exec wrangler d1 migrations apply DB --local
pnpm --filter @subetha/api dev     # http://localhost:8787
curl -X POST localhost:8787/v1/dev/bootstrap -d '{"secret":"local-dev-only","handle":"me","credit_usd":5}'
```

Local secrets go in `workers/api/.dev.vars` (gitignored), one `NAME=value` per line.
