# Cloudflare Email Routing (inbound email -> Email Worker, PLAN §6).
# Enable once the target Worker has been deployed at least once.
# Note: Cloudflare Email Routing catch-all rules apply at the zone level (var.zone_name).
# Set INBOUND_EMAIL_DOMAIN in wrangler.jsonc to match the routed zone, or delegate a dedicated
# subdomain zone (e.g. in.subetha.us) and point this module at it so root-domain mail is separate.
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
