# Subscribing

Devices and scripts receive messages by connecting to a topic. (To have the relay *push* to an
email address, phone, Slack channel, or webhook instead, see [Transports](transports.md).)

| Path | Format |
|---|---|
| `GET /{topics}/json` | Newline-delimited JSON, one envelope per line |
| `GET /{topics}/sse` | Server-sent events |
| `GET /{topics}/raw` | Message bodies only, one per line |
| `GET /{topics}/ws` | WebSocket, one JSON envelope per frame (one topic per socket) |
| `GET /{topics}/json?poll=1` | Cached messages, then the connection closes |

`{topics}` is one topic (`@alice/doorbell`) or several separated by commas
(`@alice/doorbell,@alice/alarm`). The stream starts with an `open` event and sends `keepalive`
events periodically; treat any envelope without an `event`, or with `event: "message"`, as a
message.

Reading is charged to the topic owner: one API request per connection or poll, a live-delivery
fee per message, and connection time for long-lived streams ([Pricing](pricing.md)). The topic
must exist: subscribing to one that doesn't is a 404.

## JSON stream

<!-- include: samples/curl/subscribe-json.sh -->

## Server-sent events

<!-- include: samples/curl/subscribe-sse.sh -->

## Raw

<!-- include: samples/curl/subscribe-raw.sh -->

## WebSocket

<!-- include: samples/curl/subscribe-ws.sh -->

## Polling, `since`, and filters

<!-- include: samples/curl/poll.sh -->

| Parameter | Meaning |
|---|---|
| `since` | Replay cached messages first: a message id (messages after it), Unix seconds, a duration (`30s`, `10m`, `2h`, `1d`), or `all`. Without it, a stream starts with new messages only. Polls default to `all`. |
| `poll=1` | Return what's cached and close. |
| `priority` | Only these priorities, comma-separated numbers or names (`4,5`, `high,urgent`). Aliases `prio`, `p`. |
| `tags` | Only messages carrying all of these tags. Aliases `tag`, `ta`. |

A replay returns at most 1,000 messages. To resume after a disconnect without gaps or duplicates,
reconnect with `since=<last id you saw>`. The SDKs do this for you, and dedupe by id.

With the SDK:

<!-- include: samples/ts/poll.ts#snippet -->

## Authentication

Send `Authorization: Bearer <token>`. For clients that can't (browsers' `EventSource` and
`WebSocket`, some ntfy apps), use HTTP Basic with an empty user name, or `?auth=`:

<!-- include: samples/curl/ntfy-auth.sh -->

A token needs the `subscribe` scope for the topic. Secret `t_…` topics are readable by anyone who
knows the name, and a topic's policy can make a namespaced topic public (`public_read`) or list
extra readers (`allowed_readers`). On public pages use a
[publishable token](tokens.md#publishable-tokens), never an admin one.

## Acknowledging

An ack tells the relay a message was seen, which cancels pending
[escalation steps](concepts.md#routing) (SMS, phone calls…) and releases their reservations. The
SDKs ack automatically. Over a WebSocket, send `{"event":"ack","id":"<id>"}`. Otherwise:

<!-- include: samples/curl/trace-ack.sh -->

Acking needs read access to the topic. Acks are idempotent.

## ntfy apps

The ntfy Android/iOS apps and CLI can subscribe to SubEtha: add `https://subetha.us` as a
server, use a token as the password (empty user name), and subscribe to a secret `t_…` topic
(ntfy's apps only accept topic names without `@` or `/`, which secret topics satisfy). Signed and
encrypted messages need a SubEtha SDK to verify or decrypt.
