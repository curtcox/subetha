# Tokens & policies

Two tools control who can do what, and how much it can cost: **tokens** (credentials with scopes
and caps) and **topic policies** (rules attached to a topic).

## Credentials

| Credential | How it's sent | For |
|---|---|---|
| API token `se_…` | `Authorization: Bearer se_…` (or Basic with an empty user, or `?auth=`) | scripts, servers, agents, web pages |
| Clerk session | `Authorization: Bearer eyJ…` | the web console |
| Device signature | `X-Device-Id`, `X-Device-Time`, `X-Device-Signature` | [enrolled devices](devices.md) |

All requests are rate limited: 600 per minute per credential, 60 per minute per IP without one.
Over the limit you get `429 rate_limited` with `Retry-After`.

## Tokens

<!-- include: samples/curl/tokens.sh -->

<!-- include: samples/ts/tokens.ts#snippet -->

| Field | Meaning |
|---|---|
| `scopes` | What the token may do (below). Required. |
| `transports` | Allow-list of transports its publishes may use, e.g. no `sms`/`voice`. |
| `daily_cap_usd`, `total_cap_usd` | Spend caps for everything charged to the token. |
| `origins` | Makes it a [publishable token](#publishable-tokens). |
| `ips` | Client addresses or CIDR ranges it works from, e.g. `["203.0.113.0/24", "2001:db8::/32"]` (up to 32). Requests from anywhere else get `403 forbidden`. |
| `expires_in_s` | Lifetime. |
| `name` | For your own bookkeeping. |

The secret is returned once. `GET /v1/tokens` lists tokens without secrets, and
`DELETE /v1/tokens/{id}` revokes one immediately.

### Scopes

| Scope | Allows |
|---|---|
| `admin` (or `*`) | Everything: account, billing, tokens, topics, endpoints, devices. |
| `publish`, `subscribe` | Publish to / read any topic the account can. |
| `publish:@alice/*` | Publish to any topic under `@alice/`. |
| `subscribe:@alice/doorbell` | Read one topic. |
| `publish:t_…` | One secret topic. |

A token can't create a token with more power than it has (only `admin` tokens create tokens).

### Publishable tokens

For a public web page, create a token with `origins` set. Such a token:

- only works on requests whose `Origin` header is one of `origins`;
- has exactly one non-wildcard topic scope (`subscribe:@me/status` or `publish:@me/guestbook`);
- must have a `daily_cap_usd`.

Anyone can read it from the page, so assume it's public; the scope, origin, and cap bound what it
can cost you. Use one for [`<subetha-feed>` / `<subetha-send>`](sdks.md#web-components).

## Topic policies

`PUT /v1/topics/{topic}` creates a topic or replaces its policy:

<!-- include: samples/curl/topic-policy.sh -->

<!-- include: samples/ts/topic-policy.ts#snippet -->

| Policy field | Meaning |
|---|---|
| `public_publish` | Anyone may publish without credentials. Charged to you, within the anonymous limits. |
| `anon_rate_per_min` | Anonymous publishes per minute (default 60). |
| `anon_daily_cap_micros` | Daily cap on what anonymous publishes may cost you (default $1). |
| `public_read` | Anyone may subscribe to this namespaced topic. (Secret topics are always readable by name.) |
| `allowed_publishers`, `allowed_readers` | Extra account, token, or device ids allowed to publish / read. |
| `require_signature` | Reject messages without a valid device signature. |
| `allow_transports`, `deny_transports` | Transports deliveries may / may not use. |
| `min_priority` | Per-transport minimum priority, e.g. `{"sms": 4, "voice": 5}`. |
| `max_cost_per_message_micros` | Drop deliveries beyond this cost per message. |
| `daily_cap_micros` | Daily cap on owner-side spend for this topic (deliveries and reads). |
| `retention_s` | How long messages are kept (default 12 h, up to 30 days). Longer costs more rent. |
| `quiet_hours` | `{"start": "22:00", "end": "07:00"}` (UTC): paid transports are suppressed. |
| `email_senders` | Who may publish by [inbound email](transports.md#email): addresses, `@domain`, or `*`. |
| `paused` | Kill switch: reject publishes. |

The effective rules for any delivery are the intersection of the account, topic, subscription,
token, and message settings. Nothing a publisher sends can widen what the owner allows.

## Account-level controls

`PATCH /v1/account` sets an account-wide `daily_cap_micros` and an account kill switch
(`paused`). Every change to tokens, topics, endpoints, and devices is written to an audit log: `GET /v1/audit` (admin), or the console's **Audit log** tab.
