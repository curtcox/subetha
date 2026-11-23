# API reference

The complete HTTP API is described in OpenAPI 3.1:
**[openapi.yaml](/openapi.yaml)** (source:
[`spec/openapi.yaml`](https://github.com/curtcox/subetha/blob/main/spec/openapi.yaml)). Load it
into any OpenAPI viewer or client generator. A test fails the build if a route the relay serves
is missing from it.

Base URLs: `https://subetha.us` (production), `https://staging.subetha.us` (staging, providers
in test mode), `http://localhost:8787` (`wrangler dev`).

## Routes at a glance

| Area | Routes |
|---|---|
| Publish (ntfy) | `PUT`/`POST /{topic}`, `POST /` (JSON), `GET /file/{id}/{name}` (attachments) |
| Subscribe (ntfy) | `GET /{topics}/json`, `/sse`, `/raw`, `/ws`, `/auth`; `?poll=1`, `since`, `priority`, `tags` |
| Meta | `GET /v1/health`, `/v1/status`, `/v1/prices`, `/v1/config` |
| Account & billing | `GET`/`POST`/`PATCH /v1/account`, `GET /v1/balance`, `GET /v1/ledger`, `GET /v1/payments`, `GET /v1/payments/{id}/receipt`, `POST /v1/billing/checkout` |
| Tokens | `GET`/`POST /v1/tokens`, `DELETE /v1/tokens/{id}` |
| Topics | `GET /v1/topics`, `GET`/`PUT /v1/topics/{topic}` |
| Traces & acks | `GET /v1/traces/{id}?topic=`, `POST /v1/ack` |
| Endpoints | `GET`/`POST /v1/endpoints`, `POST /v1/endpoints/{id}/verify`, `DELETE /v1/endpoints/{id}` |
| Subscriptions | `GET`/`POST /v1/subscriptions`, `DELETE /v1/subscriptions/{id}` |
| Slack | `GET /v1/slack/install`, `GET /v1/slack/oauth`, `POST /v1/slack/bindings` |
| Devices | `GET`/`POST /v1/devices`, `DELETE /v1/devices/{id}`, `POST /v1/device/code`, `/v1/device/approve`, `/v1/device/token` |
| Agents | `POST /mcp`, `GET /.well-known/oauth-protected-resource` |
| Provider hooks | `POST /v1/hooks/stripe`, `/v1/hooks/twilio/sms`, `/v1/hooks/twilio/voice-ack`, `/v1/hooks/slack/events` |
| Local only | `POST /v1/dev/bootstrap` |

## Conventions

- **Auth:** `Authorization: Bearer <token>`; HTTP Basic with an empty user and the token as the
  password; `?auth=<base64url("Bearer <token>")>`; or device request signatures
  ([Devices](devices.md#signed-requests)).
- **Money** is integer micro-dollars in responses (`*_usd_micros`); request fields that take
  dollars are named `*_usd`.
- **Times** are Unix seconds in messages and milliseconds in control-plane records
  (`created_at`).
- **CORS** is open: the API is meant to be called from web pages with publishable tokens.
  `X-Cost-Micros`, `X-Message-Id`, and `Retry-After` are exposed to scripts.
- **Rate limits:** 600 requests/minute per credential, 60/minute per IP without one; `429` with
  `Retry-After` when exceeded.

## Errors

Every error is JSON with a stable `error` code, the HTTP status, and a human-readable `message`,
plus fields specific to the error (`shortfall_usd_micros` on 402):

```json
{ "error": "spend_cap_exceeded", "http": 403, "message": "topic daily cap reached", "cap": "topic_daily" }
```

<!-- errors-table -->

The codes come from [`spec/errors.json`](https://github.com/curtcox/subetha/blob/main/spec/errors.json)
and won't change meaning; new ones may be added.

## Protocol

The message envelope, canonical JSON, signatures, encryption, dedupe, and topic grammar are
specified in [`spec/README.md`](https://github.com/curtcox/subetha/blob/main/spec/README.md), with
a [JSON Schema](https://github.com/curtcox/subetha/blob/main/spec/schema/message.schema.json) and
cross-SDK [test vectors](https://github.com/curtcox/subetha/tree/main/spec/vectors).
