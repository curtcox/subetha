# Cloudflare zone: subetha.us

Short enough to apply by hand; codify in Terraform (`cloudflare` provider) once it stabilizes.
Open question 5 in PLAN.md (is `subetha.us` on Cloudflare yet?) must be settled first.

## Hostnames

| Hostname | Points at | Created by |
|---|---|---|
| `subetha.us` | Worker `subetha-api-production` (custom domain) | `wrangler deploy --env production` |
| `mcp.subetha.us` | Worker `subetha-api-production` (custom domain; same Worker serves `/mcp`) | `wrangler deploy --env production` |
| `staging.subetha.us` | Worker `subetha-api-staging` | `wrangler deploy --env staging` |
| `in.subetha.us` | Email Routing (MX records added by the dashboard) | Email Routing setup, below |
| `dev.subetha.us` (optional) | `CNAME curtcox.github.io` for GitHub Pages | DNS + Pages settings (PLAN open question 2) |

Custom domains create their own proxied DNS records and certificates; don't add A/AAAA records
for them by hand.

## Email Routing (inbound email → topics)

1. Dashboard → `subetha.us` → Email → Email Routing → enable for the subdomain `in.subetha.us`
   (it adds the MX and SPF records).
2. Routing rules → **Catch-all** → action **Send to a Worker** → `subetha-api-production`.
   (Staging: `in.staging.subetha.us` → `subetha-api-staging`.)
3. Set `INBOUND_EMAIL_DOMAIN` to match (see `secrets.md`).

Mail to `<handle>.<name>@in.subetha.us` or `t_…@in.subetha.us` then reaches the Worker's
`email()` handler.

## Outbound email

Either:

- **Cloudflare Email Service**: enable sending for `subetha.us`, then add to each environment in
  `wrangler.jsonc`: `"send_email": [{ "name": "EMAIL" }]`; or
- **Amazon SES**: verify `subetha.us` in SES, publish its DKIM CNAMEs here, and set the `SES_*`
  secrets.

Either way, publish SPF (`v=spf1 include:… ~all`), DKIM, and
`_dmarc.subetha.us TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@subetha.us"`.

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
