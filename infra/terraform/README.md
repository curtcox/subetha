# SubEtha Cloudflare Terraform

Provisions the Cloudflare zone settings, DNS records, optional Email Routing catch-all, and
per-environment Worker bindings (D1, KV, R2, Queues) matching
[`workers/api/wrangler.jsonc`](../../workers/api/wrangler.jsonc) and
[`infra/cloudflare-zone.md`](../cloudflare-zone.md) (PLAN §12).

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in cloudflare_account_id
export CLOUDFLARE_API_TOKEN="…"
terraform init
terraform plan
terraform apply
```

Copy the printed `d1_database_ids` and `kv_namespace_ids` into `workers/api/wrangler.jsonc`
under `env.staging` and `env.production`, then deploy the Worker (`wrangler deploy` attaches the
custom domains `subetha.us`, `mcp.subetha.us`, and `staging.subetha.us`). Once the Worker is
deployed, set `manage_email_routing = true` and `enable_hsts = true` as desired and re-apply.
