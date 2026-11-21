# Publishing

There are three ways to publish, all equivalent:

| Form | Request | Use it for |
|---|---|---|
| ntfy headers | `PUT`/`POST /{topic}`, the body is the message, options in headers | `curl`, shell scripts, ntfy clients |
| Query string | `POST /{topic}?title=…&priority=…&message=…` | places that can't set headers |
| JSON | `POST /` with a JSON envelope | signed or encrypted messages, extension fields, SDKs |

The publisher's token (or account) is charged for the publish; the topic owner pays for delivery
([who pays](concepts.md#who-pays)).

## Headers

<!-- include: samples/curl/publish-headers.sh -->

| Header | Aliases (and query parameter) | Meaning |
|---|---|---|
| `X-Title` | `Title`, `t` (`?title=`) | Title. Non-ASCII works with RFC 2047 encoded words, or use JSON. |
| `X-Priority` | `Priority`, `prio`, `p` (`?priority=`) | `1`–`5`, or `min`, `low`, `default`, `high`, `max`/`urgent`. |
| `X-Tags` | `Tags`, `Tag`, `ta` (`?tags=`) | Comma-separated. ntfy clients show emoji for tags like `warning` or `white_check_mark`. |
| `X-Click` | `Click` | URL opened when the notification is tapped. |
| `X-Icon` | `Icon` | Notification icon URL. |
| `X-Actions` | `Actions` | Up to three ntfy action buttons: `view, Label, url; http, Label, url, clear=true`, or a JSON array. |
| `X-Markdown` | `Markdown`, `md` | `yes` sets `content_type: text/markdown`. |
| `X-Attach` | `Attach`, `a` | Link an attachment by URL. |
| `X-Filename` | `Filename`, `f` | Upload the body as an attachment with this name (see [Attachments](#attachments)). |
| `X-Message` | `Message`, `m` (`?message=`) | Message text when the body is empty or is an attachment. |
| `X-Expires` | | Unix seconds; capped at the topic's retention. |
| `X-Route-Mode` | | `any`, `fast`, `all`, `cheap` (see [Routing and cost](#routing-and-cost)). |
| `X-Max-Cost` | | Maximum delivery cost for this message, in USD. |
| `X-Deny` / `X-Allow` | | Comma-separated transport ids never to use / the only ones to use. |
| `Idempotency-Key` | | Makes retries safe (see [Idempotency](#idempotency)). |
| `X-Dry-Run` | | `1`: plan and price only, nothing delivered (see [Dry runs](#dry-runs)). |
| `X-Sender`, `X-Signature`, `X-Message-Id`, `X-Time` | | A signed message in header form. JSON is easier. |
| `X-Delay` | `Delay`, `X-At`, `X-In` | Scheduled delivery isn't supported yet: rejected with `unsupported`. |

The same thing from code, without the SDK:

<!-- include: samples/ts/publish-fetch.ts#snippet -->

## JSON

`POST /` takes a whole envelope. ntfy's JSON aliases work too: `priority` as a name, `attach` and
`filename`, and `markdown: true`.

<!-- include: samples/curl/publish-json.sh -->

## Routing and cost

Per message you can choose the [route mode](concepts.md#routing), cap the delivery cost, and
allow or deny transports. These narrow what the topic owner's policies already allow; they can
never widen it.

<!-- include: samples/curl/publish-route.sh -->

If no allowed transport is left for a delivery, it is dropped from the plan. The trace says why
(`transport denied by policy`, `below minimum priority`, `quiet hours`, `route mode cheap`, …).

## Dry runs

`X-Dry-Run: 1` returns the delivery plan and a worst-case estimate in µ$, and delivers nothing.
It costs one API request. The plan lists each subscriber's transport, its price, and its
escalation delay; it is shown only to the topic owner (others see an empty plan and the price).

<!-- include: samples/curl/dry-run.sh -->

<!-- include: samples/ts/dry-run.ts#snippet -->

## Idempotency

Networks fail after the server has acted. Send an `Idempotency-Key` and a retry returns the
original message with `X-Duplicate: 1` instead of delivering and charging again. Reusing a key
with a *different* request is `409 conflict`. A message's `id` works the same way: publishing an
`id` that already exists returns the stored message.

<!-- include: samples/curl/idempotency.sh -->

<!-- include: samples/ts/idempotency.ts#snippet -->

## Attachments

Send a file as the request body with `X-Filename` (up to 15 MB). The relay stores it until the
message expires and puts a download URL in `attachment.url`. The message text goes in
`X-Message`. The publisher pays an upload fee plus storage for the message's lifetime; each
download is charged to the topic owner as one API request. Images, audio, video, plain text, and
PDF open inline; everything else downloads.

<!-- include: samples/curl/attachment.sh -->

<!-- include: samples/ts/attachment.ts#snippet -->

To link something that's already hosted, use `X-Attach: <url>` instead; nothing is uploaded.

## Signed messages

A device can sign a message with its Ed25519 key. The signature covers the whole envelope except
`sig` and `hops`, and the public key is inside the `sender` id, so any receiver (or edge relay)
can verify it without a lookup. A topic policy can require signatures (`require_signature`); then
unsigned or badly signed messages get `401 signature_required` / `bad_signature`.

<!-- include: samples/ts/signed.ts#snippet -->

Signed and encrypted messages must carry their own `id` and `time` (the SDKs set them), with
`time` no more than 5 minutes ahead or 7 days behind the relay's clock. The relay delivers them
exactly as sent apart from `event`, which is outside the signature, so they still verify on the
way out.

## End-to-end encryption

With a 32-byte topic key shared out of band, the SDK encrypts `title`, `message`, `attachment`,
`click`, `actions`, and `content_type` with XChaCha20-Poly1305 before the message leaves the
device. The relay routes ciphertext and never sees keys. Push, email, SMS, and Slack deliveries of
encrypted messages show a short "encrypted message" notice instead of the text.

<!-- include: samples/ts/e2ee.ts#snippet -->

If you sign *and* encrypt, the SDK encrypts first and signs the ciphertext.

## Responses and errors

A successful publish returns `200` with the stored envelope, plus `X-Message-Id` and
`X-Cost-Micros` headers. Errors are JSON with a stable code:

```json
{ "error": "insufficient_balance", "http": 402, "message": "…", "shortfall_usd_micros": 1234 }
```

The ones you'll meet most when publishing: `invalid_topic`, `message_too_large` (body over 4096
bytes without `X-Filename`), `forbidden` (token scope or policy), `insufficient_balance` /
`no_funded_owner` (402), `spend_cap_exceeded`, `topic_paused`, `rate_limited` (429, with
`Retry-After`). The full list is in the [API reference](api.md#errors).
