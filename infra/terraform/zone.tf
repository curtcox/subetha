data "cloudflare_zone" "subetha" {
  account_id = var.cloudflare_account_id
  name       = var.zone_name
}

# Zone TLS, HTTPS, and WebSockets settings (infra/cloudflare-zone.md).
resource "cloudflare_zone_settings_override" "subetha" {
  zone_id = data.cloudflare_zone.subetha.id

  settings {
    ssl              = "strict"
    always_use_https = "on"
    min_tls_version  = "1.2"
    websockets       = "on"
    brotli           = "on"

    security_header {
      enabled            = var.enable_hsts
      max_age            = 15552000 # 6 months
      include_subdomains = var.enable_hsts
      nosniff            = true
    }
  }
}

# Optional CNAME for GitHub Pages (e.g. dev.subetha.us -> curtcox.github.io).
resource "cloudflare_record" "pages_cname" {
  count   = var.pages_subdomain != "" ? 1 : 0
  zone_id = data.cloudflare_zone.subetha.id
  name    = var.pages_subdomain
  type    = "CNAME"
  content = var.pages_target
  proxied = false
  comment = "GitHub Pages custom domain (PLAN open question 2)"
}

# DMARC policy for outbound email.
resource "cloudflare_record" "dmarc" {
  zone_id = data.cloudflare_zone.subetha.id
  name    = "_dmarc"
  type    = "TXT"
  content = "v=DMARC1; p=quarantine; rua=${var.dmarc_rua}"
  comment = "SubEtha DMARC policy"
}

# Optional SPF record for outbound email (e.g. SES or Cloudflare Email Service).
resource "cloudflare_record" "spf" {
  count   = var.spf_include != "" ? 1 : 0
  zone_id = data.cloudflare_zone.subetha.id
  name    = "@"
  type    = "TXT"
  content = "v=spf1 ${var.spf_include} ~all"
  comment = "SubEtha outbound email SPF"
}
