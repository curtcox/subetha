variable "cloudflare_account_id" {
  description = "Cloudflare Account ID hosting the subetha.us zone, D1, KV, R2, and Queues."
  type        = string
}

variable "zone_name" {
  description = "Root DNS zone managed by Cloudflare."
  type        = string
  default     = "subetha.us"
}

variable "environments" {
  description = "SubEtha deployment environments to provision Cloudflare resources for."
  type        = set(string)
  default     = ["staging", "production"]
}

variable "enable_hsts" {
  description = "Enable 6-month HSTS with includeSubDomains (enable after staging is verified)."
  type        = bool
  default     = false
}

variable "pages_subdomain" {
  description = "Optional subdomain for GitHub Pages (e.g. 'dev' for dev.subetha.us). Leave empty to skip."
  type        = string
  default     = ""
}

variable "pages_target" {
  description = "GitHub Pages CNAME target when pages_subdomain is set."
  type        = string
  default     = "curtcox.github.io"
}

variable "spf_include" {
  description = "Optional SPF include mechanism for outbound email (e.g. 'include:amazonses.com'). Leave empty to omit SPF TXT."
  type        = string
  default     = ""
}

variable "dmarc_rua" {
  description = "Aggregate DMARC report address."
  type        = string
  default     = "mailto:dmarc@subetha.us"
}

variable "manage_email_routing" {
  description = "Manage Cloudflare Email Routing settings and catch-all Worker rule for inbound email."
  type        = bool
  default     = false
}

variable "inbound_email_worker" {
  description = "Worker script name receiving catch-all inbound mail when manage_email_routing = true."
  type        = string
  default     = "subetha-api-production"
}
