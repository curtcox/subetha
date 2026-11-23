# Per-environment Cloudflare data & messaging bindings matching workers/api/wrangler.jsonc.

resource "cloudflare_d1_database" "db" {
  for_each   = var.environments
  account_id = var.cloudflare_account_id
  name       = "subetha-${each.key}"
}

resource "cloudflare_workers_kv_namespace" "cache" {
  for_each   = var.environments
  account_id = var.cloudflare_account_id
  title      = "subetha-cache-${each.key}"
}

resource "cloudflare_r2_bucket" "files" {
  for_each   = var.environments
  account_id = var.cloudflare_account_id
  name       = "subetha-files-${each.key}"
}

resource "cloudflare_r2_bucket" "backups" {
  for_each   = var.environments
  account_id = var.cloudflare_account_id
  name       = "subetha-backups-${each.key}"
}

resource "cloudflare_queue" "delivery" {
  for_each   = var.environments
  account_id = var.cloudflare_account_id
  name       = "subetha-delivery-${each.key}"
}

resource "cloudflare_queue" "delivery_dlq" {
  for_each   = var.environments
  account_id = var.cloudflare_account_id
  name       = "subetha-delivery-dlq-${each.key}"
}
