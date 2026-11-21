# Cloudflare zone: subetha.org

Short enough to apply by hand; codify in Terraform (`cloudflare` provider) once it stabilizes.
Open question 5 in PLAN.md (is `subetha.org` on Cloudflare yet?) must be settled first.

## Hostnames

| Hostname | Points at | Created by |
|---|---|---|
| `subetha.org` | Worker `subetha-api-production` (custom domain) | `wrangler deploy --env production` |
| `mcp.subetha.org` | Worker `subetha-api-production` (custom domain; same Worker serves `/mcp`) | `wrangler deploy --env production` |
| `staging.subetha.org` | Worker `subetha-api-staging` | `wrangler deploy --env staging` |
| `in.subetha.org` | Email Routing (MX records added by the dashboard) | Email Routing setup, below |
| `dev.subetha.org` (optional) | `CNAME curtcox.github.io` for GitHub Pages | DNS + Pages settings (PLAN open question 2) |

Custom domains create their own proxied DNS records and certificates; don't add A/AAAA records
for them by hand.

## Email Routing (inbound email → topics)

1. Dashboard → `subetha.org` → Email → Email Routing → enable for the subdomain `in.subetha.org`
   (it adds the MX and SPF records).
2. Routing rules → **Catch-all** → action **Send to a Worker** → `subetha-api-production`.
   (Staging: `in.staging.subetha.org` → `subetha-api-staging`.)
3. Set `INBOUND_EMAIL_DOMAIN` to match (see `secrets.md`).

Mail to `<handle>.<name>@in.subetha.org` or `t_…@in.subetha.org` then reaches the Worker's
`email()` handler.

## Outbound email

Either:

- **Cloudflare Email Service**: enable sending for `subetha.org`, then add to each environment in
  `wrangler.jsonc`: `"send_email": [{ "name": "EMAIL" }]`; or
- **Amazon SES**: verify `subetha.org` in SES, publish its DKIM CNAMEs here, and set the `SES_*`
  secrets.

Either way, publish SPF (`v=spf1 include:… ~all`), DKIM, and
`_dmarc.subetha.org TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@subetha.org"`.

## Zone settings

| Setting | Value | Why |
|---|---|---|
| SSL/TLS mode | Full (strict) | |
| Always Use HTTPS | On | |
| Minimum TLS | 1.2 | |
| HSTS | On, 6 months, include subdomains (after staging is verified) | |
| WebSockets | On | `/{topic}/ws` subscriptions |
| Brotli / caching | Defaults | API responses aren't cached; static assets are served by the Worker |
| Bot Fight Mode | **Off** for API paths | It would block `curl`, ntfy clients, and webhooks from providers |

Provider webhooks (`/v1/hooks/*`) must not be challenged by WAF or bot rules: Stripe, Twilio, and
Slack retry, but they can't solve challenges. Rate limiting is done in the Worker, so no zone rate
limiting rules are needed.
