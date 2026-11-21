# Concepts

SubEtha has a small vocabulary. Once these click, the rest of the API follows.

| Concept | What it is |
|---|---|
| **Account** | Holds the prepaid balance and owns topics, devices, endpoints, tokens, and policies. |
| **Topic** | The rendezvous point. Publishers and subscribers only ever name topics. |
| **Message** | An ntfy-compatible JSON envelope plus SubEtha extensions. |
| **Device** | Something running an SDK with its own Ed25519 key: a phone, a browser, a Pi, a CLI, an agent. |
| **Endpoint** | A non-SDK destination: an email address, a phone number, a Slack channel, a webhook URL, a push token, an LXMF address. |
| **Subscription** | Topic → endpoint, with filters and an optional escalation delay. |
| **Transport** | A path a message can take: `ws`, `sse`, `poll`, `webpush`, `apns`, `fcm`, `webhook`, `email`, `slack`, `sms`, `voice`, `mcp`, `lxmf`, and the edge transports `ble`, `audio`, `qr`, `lan`. |
| **Trace** | Per-message record of the route plan, each delivery attempt, acks, and cost. Only the topic owner sees it. |

## Topics

A topic name is one of:

| Form | Example | Notes |
|---|---|---|
| Namespaced | `@alice/doorbell` | `@handle/name`. Only Alice's account can create topics under `@alice/`. Names are `[A-Za-z0-9_-]{1,64}`. |
| Secret | `t_mfrggzdfmztwq2lknnwg23tpoa` | `t_` + 26 base32 characters (128 random bits). Anyone who knows the name can read it, like an ntfy "secret URL". Stock ntfy clients accept these names unchanged. |

Global names like `subetha.org/mytopic` are not accepted.

A topic is created by its owner's first publish to it, or explicitly with
`PUT /v1/topics/{topic}` (which also sets its [policy](tokens.md#topic-policies)). Subscribing to
a topic that doesn't exist yet returns 404.

Namespaced topics are private by default: only the owner's credentials can read and publish. A
policy can open them up (`public_read`, `public_publish`, `allowed_publishers`,
`allowed_readers`).

## Messages

A message is a superset of ntfy's message JSON:

```json
{
  "id": "01JD5Z8W3V6X0M3K9Q2T4R7B1C",
  "time": 1763750000,
  "expires": 1763793200,
  "event": "message",
  "topic": "@alice/doorbell",
  "title": "Front door",
  "message": "Opened",
  "priority": 4,
  "tags": ["door", "warning"],
  "click": "https://cam.example.com/front",
  "attachment": { "name": "snap.jpg", "url": "https://subetha.org/file/01jd…/snap.jpg", "size": 81234, "type": "image/jpeg" },
  "route": { "mode": "any", "max_cost_usd_micros": 20000, "deny": ["voice"] }
}
```

- `id` is a ULID and the dedupe key everywhere: the same message arriving over a WebSocket and a
  push notification is shown once.
- `priority` is 1–5 (3 is the default and is omitted).
- `message` is at most 4096 bytes. Larger content goes in an [attachment](publishing.md#attachments).
- Messages are kept until `expires` (12 hours by default; a topic's `retention_s` can raise it to
  30 days), so subscribers that reconnect can catch up with `since=`.
- Optional extensions: `sender` + `sig` ([signatures](publishing.md#signed-messages)), `enc`
  ([end-to-end encryption](publishing.md#end-to-end-encryption)), `route`, `content_type`, and
  `hops` (edge relaying).

The normative definition is the [protocol spec](https://github.com/curtcox/subetha/blob/main/spec/README.md)
and its [JSON Schema](https://github.com/curtcox/subetha/blob/main/spec/schema/message.schema.json).

## Devices and endpoints

There are two ways to receive:

- **Devices** run an SDK and connect: a WebSocket, an SSE or NDJSON stream, or polling. Live
  delivery is cheap, and SDKs ack messages so escalation stops. A device has its own key and can
  sign messages and requests ([Devices](devices.md)).
- **Endpoints** are destinations the relay pushes to: push tokens, email addresses, phone
  numbers, Slack channels, webhooks, LXMF addresses. The topic owner adds them and subscribes
  them to topics. Paid destinations a third party could be spammed through (email, SMS, voice)
  must be **verified** with a code first ([Transports](transports.md)).

## Routing

On every publish the relay builds a **delivery plan**. For each subscriber it intersects what's
allowed by the account, the topic policy, the subscription, the token, and the message (`allow`
and `deny` lists, priority thresholds, quiet hours, cost caps), then orders what's left by the
**route mode**:

| Mode | Behavior |
|---|---|
| `any` (default) | Deliver once, by the cheapest viable path. Escalation steps run only if the message is still unacked. |
| `fast` | Lowest latency first. |
| `all` | Every allowed transport at once (alarms). |
| `cheap` | Free/live transports only; never escalate to paid ones. |

**Escalation** is configured per subscription with `after_s`: for example push immediately, SMS
after 60 s, a phone call after 180 s. Each step is queued with its own reservation and is skipped
(and its reservation released) once anyone acks the message: an SDK, a WebSocket ack frame, a
Web Push service worker, replying `ACK <id>` by SMS, pressing 1 on the call, or `POST /v1/ack`.
See the [escalation example](transports.md#escalation).

The relay never tells a device which other devices exist or how they were reached. Only the owner
sees that, in the [trace](pricing.md#traces).

## Who pays?

- The **publisher** pays for the publish (and for any attachment it uploads).
- The **topic owner** pays for fan-out and delivery: live deliveries, pushes, emails, SMS,
  storage, and reads (polls, stream connections, attachment downloads).
- **Anonymous** publishing works only on topics whose owner allows it (`public_publish`), with a
  per-minute rate limit and a daily cap, charged to the owner. If the owner can't pay, the
  publish fails with `402 no_funded_owner`.

So `curl -d hi subetha.org/@alice/doorbell` can be free for the person ringing the bell, while
Alice decides exactly how much ringing she's willing to pay for. Details: [Pricing & billing](pricing.md).
