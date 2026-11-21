import type { Envelope, RouteMode, Transport } from "@subetha/sdk/protocol";
import type { AccountDO } from "./durable/account.ts";
import type { TopicDO } from "./durable/topic.ts";

export interface Env {
  ENVIRONMENT: "local" | "staging" | "production";
  BASE_URL: string;
  DB: D1Database;
  CACHE: KVNamespace;
  FILES?: R2Bucket;
  TOPIC: DurableObjectNamespace<TopicDO>;
  ACCOUNT: DurableObjectNamespace<AccountDO>;
  DELIVERY?: Queue<DeliveryJob>;
  ASSETS?: Fetcher;
  RL_AUTH?: RateLimit;
  RL_ANON?: RateLimit;
  // Clerk
  CLERK_ISSUER?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_JWKS_URL?: string;
  CLERK_JWKS?: string; // inline JWKS JSON (local/test)
  CLERK_AUTHORIZED_PARTIES?: string; // comma-separated
  // Stripe
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Local development only
  DEV_BOOTSTRAP_SECRET?: string;
  // Delivery providers (secrets)
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
  EMAIL_FROM?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  SES_REGION?: string;
  EMAIL?: SendEmail;
  WEBHOOK_SIGNING_SECRET?: string;
  FCM_SERVICE_ACCOUNT?: string; // JSON
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  APNS_ENDPOINT?: string; // default https://api.push.apple.com (needs HTTP/2; see docs)
  LXMF_GATEWAY_URL?: string;
  LXMF_GATEWAY_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  INBOUND_EMAIL_DOMAIN?: string; // in.subetha.org
}

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

export interface TopicMeta {
  name: string;
  owner: string; // account id
  policy: TopicPolicy;
  created_at: number;
}

export type Principal =
  | { kind: "anonymous" }
  | { kind: "token"; accountId: string; tokenId: string; scopes: string[]; caps: { daily: number | null; total: number | null }; transports: Transport[] | null }
  | { kind: "user"; accountId: string | null; clerkId: string }
  | { kind: "device"; accountId: string; deviceId: string };

/** The part of a principal that crosses into Durable Objects. */
export interface Caller {
  accountId: string | null;
  tokenId: string | null;
  deviceId: string | null;
  caps: { daily: number | null; total: number | null };
  transports: Transport[] | null;
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

export interface PublishInput {
  envelope: Envelope;
  caller: Caller;
  /** If the topic has no owner yet, create it with this owner. */
  autoCreateOwner: string | null;
  idempotencyKey: string | null;
  bodyHash: string;
  dryRun: boolean;
  /** Size of an attachment uploaded with this publish (charged upload + retention to the publisher). */
  attachmentBytes?: number;
  route: { mode: RouteMode; maxCost: number | null; deny: Transport[]; allow: Transport[] | null };
}

export interface PlannedDelivery {
  subscriber: string; // opaque, only shown to the owner in traces
  transport: Transport;
  sku: string | null;
  cost_micros: number;
  after_s: number;
}

export interface PublishResult {
  message: Envelope;
  created_topic: boolean;
  duplicate: boolean;
  cost_micros: number;
  plan: PlannedDelivery[];
  dry_run: boolean;
}

export interface DeliveryJob {
  topic: string;
  owner: string;
  message: Envelope;
  sub: QueuedSubscription;
  reservation: { ref: string; micros: number };
  attempt: number;
}
