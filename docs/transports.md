# Transports

A transport is a path a message can take. Some are **live** (a device holds a connection), some
are **relay-pushed** to an endpoint (push, email, SMS…), and some are **edge** transports that run
entirely on devices and never touch the relay.

| Transport | id | Kind | Endpoint address | Verified by code? |
|---|---|---|---|---|
| WebSocket / SSE / JSON stream / poll | `ws`, `sse`, `poll` | live | – | – |
| Web Push | `webpush` | push | browser push subscription JSON | no (the browser owns it) |
| Apple Push (APNs) | `apns` | push | hex device token | no |
| Firebase Cloud Messaging | `fcm` | push | FCM registration token | no |
| Webhook | `webhook` | relay | `https://` URL | no (signed; secret shown once) |
| Email | `email` | relay, in/out | email address | **yes** |
| Slack | `slack` | relay, in/out | channel (via the Slack app) | OAuth install |
| SMS | `sms` | relay, in/out | E.164, US or an opt-in country | **yes** |
| Voice | `voice` | relay | E.164, US or an opt-in country | **yes** |
| WhatsApp | `whatsapp` | relay, in/out | E.164, US or an opt-in country | **yes** |
| MCP | `mcp` | live (agents) | – | – |
| Reticulum / LXMF | `lxmf` | gateway | 32-hex LXMF destination | no |
| Bluetooth LE, audio, QR, LAN | `ble`, `audio`, `qr`, `lan` | edge | – | – (free, SDK only) |

The general recipe for relay-pushed transports:

1. `POST /v1/endpoints` with a `kind` and `address`. Email, SMS, and voice endpoints receive a
   6-digit code (charged like one delivery), which you confirm with
   `POST /v1/endpoints/{id}/verify` within 30 minutes (5 attempts).
2. `POST /v1/subscriptions` to deliver a topic to that endpoint, optionally with a `filter`
   (priorities, tags), `min_priority`, and `after_s` (an escalation delay).

Only the topic owner can subscribe endpoints to a topic, because the owner pays for delivery.
Deliveries are queued, retried with backoff on transient failures (timeouts, 429, 5xx), and
dropped on permanent ones (4xx, a revoked push token, an unverified endpoint). Every attempt is in
the message's [trace](pricing.md#traces). `GET /v1/status` shows which transports a deployment
has configured.

Each section below also lists the secrets an operator must set for the transport to work (see
[`infra/secrets.md`](https://github.com/curtcox/subetha/blob/main/infra/secrets.md) for where to
get each one).

## Live: WebSocket, SSE, JSON, poll

Covered in [Subscribing](subscribing.md). These are the cheapest transports and need no setup.
In `cheap` route mode they're the only ones used.

## Web Push

Browsers (desktop and Android, and iOS 16.4+ for installed web apps) receive notifications even
when the page is closed. The relay encrypts each push with aes128gcm (RFC 8291) and signs it with
a VAPID token (RFC 8292). Urgency follows priority (1–2 `low`, 3 `normal`, 4–5 `high`), the TTL
follows `expires` (default 24 h), and the push `Topic` is the message id, so a retried send
replaces an undelivered copy.

In the browser: read `vapid_public_key` from `GET /v1/config`, register a service worker (the
site's [`/sw.js`](https://github.com/curtcox/subetha/blob/main/apps/site/public/sw.js) shows the
notification, opens the click URL, and acks), call `subscribeWebPush()` from the SDK, and register
the result as an endpoint:

<!-- include: samples/web/webpush.js -->

The console's "Notify this browser for these topics" button does exactly this.

**Operator setup:** generate keys with `node workers/api/scripts/vapid-keys.mjs`, then set
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a `mailto:` or `https:` contact).

## APNs and FCM

Native apps register their push token as an endpoint (the SDKs do this):

<!-- include: samples/curl/endpoint-push.sh -->

Each push carries the SubEtha envelope, trimmed to fit the service's payload limit: large
optional fields go first, and `id`, `topic`, `title`, `message`, and `priority` are always kept
(the message may be shortened). A trimmed envelope has `truncated: true`, so the app can fetch the
full message by id. When a push service says a token is gone (Web Push 404/410, FCM
`UNREGISTERED`, APNs 410 `BadDeviceToken`/`Unregistered`), the endpoint is marked unverified and
removed from its topics; the app must register again.

**FCM setup:** set `FCM_SERVICE_ACCOUNT` to the service-account JSON from the Firebase console.
The relay mints and caches OAuth2 access tokens itself. FCM also reaches iOS apps that use
Firebase.

**APNs setup:** set `APNS_KEY_P8` (the `.p8` key, PEM), `APNS_KEY_ID`, `APNS_TEAM_ID`, and
`APNS_TOPIC` (the app's bundle id).

**BYO credentials (your own app):** to push to your own iOS bundle ID or Firebase project, upload
your APNs `.p8` key or Firebase service-account JSON via `POST /v1/push/credentials`. Private keys
are verified with WebCrypto on upload, stored write-only, and never returned by `GET`. The first
credential of each kind becomes your account default; you can also pin a specific `credential_id`
when creating or updating an `apns` or `fcm` endpoint (including `sandbox: true` for APNs
development builds).

> **HTTP/2.** APNs only accepts HTTP/2, and a Worker's outbound `fetch()` isn't guaranteed to
> negotiate it with `api.push.apple.com`. Run the APNs relay in
> [`gateways/apns-relay`](https://github.com/curtcox/subetha/tree/main/gateways/apns-relay) (a
> zero-dependency Node service that forwards `POST /3/device/{token}` over one long-lived HTTP/2
> connection) and set `APNS_ENDPOINT` to its URL and `APNS_RELAY_SECRET` to its secret. Or
> deliver to iOS through FCM instead.

## Webhooks

The relay POSTs each message as JSON to your HTTPS URL, signed like Stripe webhooks. Webhooks
can't target the relay itself or private addresses. Requests time out after 10 seconds; 4xx
responses (other than 408 and 429) aren't retried.

<!-- include: samples/curl/endpoint-webhook.sh -->

<!-- include: samples/ts/webhook.ts#snippet -->

Verify the signature before trusting the body:

<!-- include: samples/ts/verify-webhook.ts#snippet -->

<!-- include: samples/python/verify_webhook.py -->

No operator secrets are needed: each endpoint gets its own signing secret.

### Testing an endpoint

`POST /v1/endpoints/{id}/test` sends one sample message to a verified endpoint right away. For a
webhook, the response shows the exact request the relay sent (headers, `X-SubEtha-Signature`,
raw body) and what your server answered (status, headers, the first 4 KB of the body), so you can
debug a signature check without publishing. Other transports report the provider's outcome. A
test costs one delivery of that transport, whether or not the receiver accepts it.

<!-- include: samples/curl/endpoint-test.sh -->

The console's **Endpoints** tab has a **Test** button on each verified endpoint and a signature
checker that runs in the browser, so the secret never leaves the page.

## Email

**Outbound** email goes only to verified addresses. The subject is the message title (or the
topic and the start of the message), and the body has the message, the click URL, and a manage
link.

<!-- include: samples/curl/endpoint-email.sh -->

**Inbound:** mail sent to a topic's address publishes to the topic, charged to the topic owner.
The address is `<handle>.<name>@in.subetha.us` for `@handle/name`, or `t_…@in.subetha.us` for
a secret topic. The subject becomes the title and the plain-text body (quoted replies and
signatures removed) the message, tagged `email`. Only senders allowed by the topic's
`email_senders` policy get through: exact addresses, `@example.com` for a whole domain, or `*`.
Messages over 512 KB are rejected.

**Operator setup:** outbound uses the Cloudflare Email Service `send_email` binding `EMAIL` when
bound, otherwise Amazon SES (`SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_REGION`). Set
`EMAIL_FROM` (default `SubEtha <notify@subetha.us>`) and authenticate the sending domain (SPF,
DKIM, DMARC). Inbound needs Cloudflare Email Routing on `in.subetha.us` with a catch-all rule
that sends to the Worker (`INBOUND_EMAIL_DOMAIN`).

## Slack

Install the SubEtha Slack app in a workspace, then bind channels to topics. Outbound, topic
messages are posted to the channel; inbound, channel messages publish to the topic (tagged
`slack`, never echoed back into the same channel). In the console, **Endpoints → Add to Slack**
installs the app and **Bind channel** binds one; from scripts, `GET /v1/slack/teams` lists the
workspaces you installed it in (their `team_id`s):

<!-- include: samples/curl/slack.sh -->

**Operator setup:** create a Slack app with the bot scopes `chat:write`, `channels:history`,
`groups:history`, and `channels:read`, the OAuth redirect URL `https://subetha.us/v1/slack/oauth`,
and Event Subscriptions (`message.channels`, `message.groups`) sent to
`https://subetha.us/v1/hooks/slack/events`. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
`SLACK_SIGNING_SECRET`.

## SMS and voice

SMS and voice calls are for things that matter: alarms and escalation. Limits that keep them safe
for everyone:

- **US numbers by default** (`+1NXXNXXXXXX`), each verified with a code sent to it.
  Premium-rate (`+1 900`) and non-geographic codes are never served, and numbers in Canada, Puerto
  Rico, and the Caribbean are not US numbers (Twilio prices them separately).
- **Other countries are opt-in, one at a time**, and priced per destination: see
  [below](#numbers-outside-the-us).
- **Recipients stay in control.** Replying `STOP` (or `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`)
  unverifies the number for SMS and voice on every account. `HELP` gets the help message. Replying
  `ACK <message id>` acknowledges a message; pressing 1 on a call does the same.
- **New-funds hold.** Until your first top-up is 7 days old, total SMS and voice spend is capped
  at $5 (PLAN §8: chargeback and SMS-pumping protection).
- **Circuit breaker.** If Twilio's US prices rise above what SubEtha's prices assume, SMS and
  voice pause (`GET /v1/status` shows `telephony_circuit`) until prices are regenerated.
- SMS bodies are cut to 459 characters (3 segments) and billed per segment; calls are billed per
  started minute. A topic policy can require a minimum priority (`"min_priority": {"sms": 4}`).
- **Texting in.** `PATCH /v1/endpoints/{id}` with `{"inbound_topic": "@you/texts"}` makes texts
  from that verified number to the SubEtha number publish to a topic you own (tagged `sms`,
  charged as `inbound_sms_us`). A text with a JPEG, PNG, or GIF picture is charged as
  `inbound_mms_us`, and the picture becomes the message's attachment (stored and billed like any
  other attachment). Replying `ACK <message id>` acknowledges an escalation instead.
- **Pictures go as MMS.** When a message has a JPEG, PNG, or GIF attachment of up to 5 MB (and
  isn't end-to-end encrypted), US numbers get one MMS with the picture and up to 1,600 characters
  of text, billed as one `deliver_mms_us` message instead of per segment. Numbers outside the US
  get the text as SMS. Dry runs show which SKU each subscriber will be billed.

### Numbers outside the US

Enable each country you want to reach on the account, then add numbers there as usual:

```bash
curl -X PATCH -H "Authorization: Bearer $SUBETHA_TOKEN" -d '{"telephony_countries":["CA","GB"]}' \
  https://subetha.us/v1/account
curl https://subetha.us/v1/prices/destinations   # today's per-country prices (public)
```

- Countries on offer: CA, GB, IE, DE, FR, NL, BE, ES, IT, PT, AT, CH, SE, NO, DK, FI, PL, AU, NZ,
  JP, SG, MX, BR, IN, IL, ZA, and PR. Adding a number in a country that isn't enabled fails with
  `forbidden`.
- **Live prices.** A daily job reads Twilio's current prices for each country and prices SMS
  segments and call minutes from the highest of them (the `deliver_sms_intl` and
  `deliver_voice_intl` SKUs: same margin floor as every other SKU). Prices go in
  `GET /v1/prices/destinations` per tier.
- **Unknown means no.** A country with no current price (Twilio didn't report one, the price is
  above $0.50 a unit, or the table is more than three days old) can't get new endpoints
  (`provider_unavailable`), and its numbers drop out of delivery plans with the reason
  `destination price unknown` in the trace.
- Removing a country from `telephony_countries` stops deliveries to its numbers at once; the
  endpoints stay, and deliver again if you re-enable it.

### Escalation

<!-- include: samples/curl/escalation.sh -->

**Operator setup:** a Twilio account with a US number registered for A2P 10DLC. Set
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM`, and point the number's incoming
message webhook at `https://subetha.us/v1/hooks/twilio/sms` (HTTP POST). Voice acks call back to
`/v1/hooks/twilio/voice-ack` automatically. The SMS consent, STOP, and HELP language is in the
[Acceptable Use Policy](legal/aup.md).

## MCP

AI agents connect to the remote MCP server at `/mcp` and publish, poll, and wait for messages
like any other device. See [Agents](agents.md).

## Reticulum / LXMF

Every mesh user on Sideband, NomadNet, or MeshChat can be a subscriber. Two directions:

- **Topic → an LXMF address:** add an `lxmf` endpoint; the hosted gateway delivers it over the mesh.
- **A topic gets its own LXMF address:** run the [Reticulum gateway](self-hosting.md#reticulum-gateway),
  which bridges both ways and lets mesh users `/subscribe`.

<!-- include: samples/curl/endpoint-lxmf.sh -->

**Operator setup:** `LXMF_GATEWAY_URL` (the gateway's base URL) and `LXMF_GATEWAY_SECRET` (the
HMAC secret it verifies `POST /deliver` with).

## Edge transports: BLE, audio, QR, LAN

Bluetooth LE store-and-forward, data-over-sound, animated QR codes, and LAN discovery run inside
the SDKs (the Rust core's `edge` modules) between nearby devices. They never touch the relay and
are free. Signatures and end-to-end encryption mean an edge relay can neither forge nor read what
it carries, and `hops` limits how far a message travels. A device with internet access can bridge
edge traffic to the relay; that leg is billed as a normal relay delivery. See
[Edge transports](edge.md) for the SDK APIs, the browser shims, and the
[Edge lab](/tools/edge.html).
