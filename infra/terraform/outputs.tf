output "zone_id" {
  description = "Cloudflare Zone ID for subetha.us."
  value       = data.cloudflare_zone.subetha.id
}

output "d1_database_ids" {
  description = "D1 database IDs to place in workers/api/wrangler.jsonc."
  value       = { for k, db in cloudflare_d1_database.db : k => db.id }
}

output "kv_namespace_ids" {
  description = "KV namespace IDs to place in workers/api/wrangler.jsonc."
  value       = { for k, kv in cloudflare_workers_kv_namespace.cache : k => kv.id }
}

output "r2_buckets" {
  description = "Provisioned R2 attachment and backup bucket names."
  value = {
    for k in var.environments : k => {
      files   = cloudflare_r2_bucket.files[k].name
      backups = cloudflare_r2_bucket.backups[k].name
    }
  }
}

output "queues" {
  description = "Provisioned delivery queue IDs."
  value = {
    for k in var.environments : k => {
      delivery = cloudflare_queue.delivery[k].id
      dlq      = cloudflare_queue.delivery_dlq[k].id
    }
  }
}
