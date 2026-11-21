// Plain data types shared by the relay and by pure modules that the site bundles (routing,
// telephony units). No Cloudflare globals here, so apps/site can typecheck against it.
import type { Transport } from "@subetha/sdk/protocol";

export interface TopicPolicy {
  /** Anyone may publish (charged to the owner, rate-limited and capped). */
  public_publish?: boolean;
  /** Anyone may subscribe to a namespaced topic. Secret (t_) topics are always readable by name. */
  public_read?: boolean;
  anon_rate_per_min?: number;
  anon_daily_cap_micros?: number;
  require_signature?: boolean;
  /** Account ids, token ids, or device ids allowed to publish besides the owner. */
  allowed_publishers?: string[];
  allowed_readers?: string[];
  allow_transports?: Transport[];
  deny_transports?: Transport[];
  max_cost_per_message_micros?: number;
  daily_cap_micros?: number;
  retention_s?: number;
  paused?: boolean;
  /** Minimum message priority for a transport, e.g. { sms: 4 }. */
  min_priority?: Partial<Record<Transport, number>>;
  /** Inbound email senders allowed to publish via topic@in.subetha.org ("*" = anyone). */
  email_senders?: string[];
  /** UTC "HH:MM"–"HH:MM": paid transports are suppressed (downgrade to free ones). */
  quiet_hours?: { start: string; end: string };
}

export interface SubscriptionFilter {
  priority?: number[];
  tags?: string[];
}

export interface QueuedSubscription {
  id: string;
  transport: Transport;
  /** Endpoint id (email, phone, webhook, slack channel, push subscription…). */
  endpoint: string;
  /** Endpoint address (email, E.164 number, URL, channel id, push subscription JSON, LXMF hash). */
  address?: string;
  filter?: SubscriptionFilter;
  /** Escalation: deliver via this transport only if unacked after `after_s` seconds. */
  after_s?: number;
  min_priority?: number;
}

export interface PlannedDelivery {
  subscriber: string; // opaque, only shown to the owner in traces
  transport: Transport;
  sku: string | null;
  cost_micros: number;
  after_s: number;
}
