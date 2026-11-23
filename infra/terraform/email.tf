# Cloudflare Email Routing (inbound email -> Email Worker, PLAN §6).
# Enable once the target Worker has been deployed at least once.
resource "cloudflare_email_routing_settings" "subetha" {
  count   = var.manage_email_routing ? 1 : 0
  zone_id = data.cloudflare_zone.subetha.id
  enabled = true
}

resource "cloudflare_email_routing_catch_all" "inbound" {
  count   = var.manage_email_routing ? 1 : 0
  zone_id = data.cloudflare_zone.subetha.id
  name    = "SubEtha inbound topics"
  enabled = true

  matcher {
    type = "all"
  }

  action {
    type  = "worker"
    value = [var.inbound_email_worker]
  }

  depends_on = [cloudflare_email_routing_settings.subetha]
}
