# Push delivery (Web Push, FCM, APNs)

The relay delivers queued messages to push services from `src/delivery/{webpush,fcm,apns}.ts`,
using only WebCrypto. Each push carries the SubEtha envelope, trimmed to fit the service's limit:
large optional fields go first, and `id`, `topic`, `title`, `message` and `priority` are always
kept, though the message may be shortened. A trimmed envelope has `truncated: true`, so apps know
to fetch the full message by id.

When a push service says a subscription or token is gone (Web Push 404/410, FCM `UNREGISTERED` or
an invalid token, APNs 410 `BadDeviceToken`/`Unregistered`), the endpoint is marked unverified
and removed from its topics. The client must register again with `POST /v1/endpoints`.
Throttling (429) and 5xx responses are retried.

## Web Push

1. Generate keys: `node workers/api/scripts/vapid-keys.mjs`, then
   `wrangler secret put VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`
   (`mailto:` or `https:` contact).
2. Browsers read the public key from `GET /v1/config` (`vapid_public_key`), register
   `/sw.js` (served from `apps/site/public`), and call `subscribeWebPush(registration, key)`
   from `@subetha/sdk`. They then POST `{"kind": "webpush", "address": <returned JSON>}` to
   `/v1/endpoints`.

Pushes are encrypted with aes128gcm (RFC 8291) and signed with a VAPID token (RFC 8292). Urgency
comes from priority: 1–2 is `low`, 3 is `normal`, and 4–5 is `high`. TTL comes from `expires`,
with a default of 24 h. The `Topic` header is the message id, so a retried send replaces an
undelivered copy of the same message.

## FCM (Android, and iOS through Firebase)

Set `FCM_SERVICE_ACCOUNT` to the service-account JSON from the Firebase console. The relay mints
OAuth2 access tokens itself and caches them. The endpoint address is the FCM registration token.

## APNs

Set `APNS_KEY_P8` (the `.p8` PKCS#8 PEM), `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_TOPIC` (the
bundle id). The endpoint address is the hex device token.

**HTTP/2 caveat:** APNs only accepts HTTP/2, and a Worker's outbound `fetch()` may not negotiate
HTTP/2 with `api.push.apple.com`. If deliveries fail, you have two options:

- Set `APNS_ENDPOINT` to an HTTP/1.1 → HTTP/2 relay that forwards `POST /3/device/{token}` with
  its headers and body unchanged.
- Deliver to iOS through FCM instead: register the app with Firebase and use `fcm` endpoints.
