import type { Envelope, RouteMode, Transport } from "@subetha/sdk/protocol";
import type { AccountDO } from "./durable/account.ts";
import type { TopicDO } from "./durable/topic.ts";
import type { PlannedDelivery, QueuedSubscription, SubscriptionFilter, TopicPolicy } from "./model.ts";

export type { PlannedDelivery, QueuedSubscription, SubscriptionFilter, TopicPolicy } from "./model.ts";

export interface Env {
  ENVIRONMENT: "local" | "staging" | "production";
  BASE_URL: string;
  DB: D1Database;
  CACHE: KVNamespace;
  FILES?: R2Bucket;
  /** Nightly D1 backups (backup.ts); a separate private bucket. */
  BACKUPS?: R2Bucket;
  BACKUP_RETENTION_DAYS?: string;
  TOPIC: DurableObjectNamespace<TopicDO>;
  ACCOUNT: DurableObjectNamespace<AccountDO>;
  DELIVERY?: Queue<DeliveryJob>;
  ASSETS?: Fetcher;
  RL_AUTH?: RateLimit;
  RL_ANON?: RateLimit;
  /** Usage metering & cost telemetry (PLAN §7). */
  ANALYTICS?: AnalyticsEngineDataset;
  // Clerk
  CLERK_ISSUER?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_JWKS_URL?: string;
  CLERK_JWKS?: string; // inline JWKS JSON (local/test)
  CLERK_AUTHORIZED_PARTIES?: string; // comma-separated
  CLERK_WEBHOOK_SECRET?: string; // Svix signing secret (whsec_…)
  // OAuth resource server (MCP): RFC 7662 introspection of opaque access tokens (oauth.ts)
  OAUTH_INTROSPECTION_URL?: string; // default ${CLERK_ISSUER}/oauth/token_info
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
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
  /** Twilio REST base URL (default https://api.twilio.com); local E2E tests point it at a mock. */
  TWILIO_API_BASE?: string;
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
  APNS_SANDBOX_ENDPOINT?: string; // default https://api.sandbox.push.apple.com (for BYO sandbox APNs creds)
  APNS_RELAY_SECRET?: string; // sent as x-relay-secret when APNS_ENDPOINT is gateways/apns-relay
  LXMF_GATEWAY_URL?: string;
  LXMF_GATEWAY_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  INBOUND_EMAIL_DOMAIN?: string; // in.subetha.us
}

export interface TopicMeta {
  name: string;
  owner: string; // account id
  policy: TopicPolicy;
  created_at: number;
  tier?: string;
}

export type Principal =
  | { kind: "anonymous" }
  | { kind: "token"; accountId: string; tokenId: string; scopes: string[]; caps: { daily: number | null; total: number | null }; transports: Transport[] | null }
  | { kind: "user"; accountId: string | null; clerkId: string; orgId?: string; orgRole?: string }
  | { kind: "device"; accountId: string; deviceId: string; transports: Transport[] | null; denyTransports: Transport[] | null };

/** The part of a principal that crosses into Durable Objects. */
export interface Caller {
  accountId: string | null;
  tokenId: string | null;
  deviceId: string | null;
  caps: { daily: number | null; total: number | null };
  transports: Transport[] | null;
  denyTransports?: Transport[] | null;
}

export interface PublishInput {
  envelope: Envelope;
  caller: Caller;
  /** If the topic has no owner yet, create it with this owner. */
  autoCreateOwner: string | null;
  /** Account-level transport policy to apply if the topic is auto-created. */
  autoCreateAccountTransports?: { allow: Transport[] | null; deny: Transport[] | null };
  /** Account pricing tier to apply if the topic is auto-created. */
  autoCreateTier?: string;
  idempotencyKey: string | null;
  bodyHash: string;
  dryRun: boolean;
  /** Size of an attachment uploaded with this publish (charged upload + retention to the publisher). */
  attachmentBytes?: number;
  route: { mode: RouteMode; maxCost: number | null; deny: Transport[]; allow: Transport[] | null; deadlineS?: number | null };
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
  /** The planned SKU (e.g. MMS_SKU for an SMS subscriber getting an MMS); absent on older jobs. */
  sku?: string | null;
  /** Epoch ms after which the job should be skipped rather than delivered (`route.deadline_s`). */
  deadline_ms?: number;
}
