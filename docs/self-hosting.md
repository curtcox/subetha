# Self-hosting & gateways

There are three ways to run SubEtha pieces yourself: run the whole relay locally (for
development or your own deployment), run a **gateway** that bridges another network to topics,
or write your own gateway with an SDK.

## Run the relay locally

The relay is one Cloudflare Worker with Durable Objects, D1, KV, R2, and a Queue. `wrangler dev`
simulates all of them on your machine.

<!-- include: samples/curl/local-dev.sh -->

`POST /v1/dev/bootstrap` exists only when `ENVIRONMENT=local` and `DEV_BOOTSTRAP_SECRET` is set
(both are, in the default local config in `workers/api/wrangler.jsonc`). Provider integrations
(Stripe, Twilio, Slack, push, email) stay disabled until you set their secrets in
`workers/api/.dev.vars`; see [`infra/secrets.md`](https://github.com/curtcox/subetha/blob/main/infra/secrets.md).

## Deploy your own

[`infra/README.md`](https://github.com/curtcox/subetha/blob/main/infra/README.md) has the
one-time Cloudflare setup (D1, KV, R2, Queues, rate limits, custom domains) and the GitHub Actions
deploy workflow (staging on every push to `main`, production on `v*` tags). Point SDKs and
clients at your deployment with `baseUrl` / `SUBETHA_URL`.

To deliver to iOS through APNs, also run the
[APNs relay](https://github.com/curtcox/subetha/tree/main/gateways/apns-relay): APNs needs
HTTP/2, which a Worker can't be relied on to speak. It's one dependency-free Node process (or
Docker image) with no Apple credentials; set `APNS_ENDPOINT` and `APNS_RELAY_SECRET` to point the
Worker at it.

## Reticulum gateway

[`gateways/reticulum`](https://github.com/curtcox/subetha/tree/main/gateways/reticulum) bridges
[Reticulum](https://reticulum.network)/LXMF meshes to topics. Each mapped topic gets its own LXMF
address, so anyone on the mesh (Sideband, NomadNet, MeshChat) can publish to it and `/subscribe`
to it with no IP connectivity at all.

```bash
pip install -e sdk/python -e "gateways/reticulum[rns]"
cp gateways/reticulum/gateway.example.toml gateway.toml   # list your topics
export SUBETHA_TOKEN=se_…   # publish + subscribe on those topics, with a spend cap
subetha-reticulum --config gateway.toml
```

It runs anywhere Reticulum does (a Raspberry Pi with an RNode, a home server, a VPS) and needs no
special access: it uses only the public API. Several gateways can serve the same topic, and they
won't echo each other's messages. The gateway's token pays for what mesh users publish, so scope
it and cap it. The hosted gateway also accepts relay-pushed deliveries for `lxmf` endpoints on
`POST /deliver` (HMAC-signed with `LXMF_GATEWAY_SECRET`). Docker and Cloudflare Containers notes
are in the gateway's README.

## Bring your own gateway

Anything that can subscribe and publish is a gateway. The pattern: subscribe to the topic and
forward to your transport; read from your transport and publish to the topic; remember the ids you
published so you don't echo them back.

<!-- include: samples/python/byo_gateway.py -->

Tips:

- Use a dedicated token scoped to the bridged topics, with a daily cap and a transport allow-list.
- Tag bridged messages (`tags=["lora"]`) and deny expensive transports on them if they can be
  noisy (`route={"deny": ["sms", "voice"]}`).
- Persist the last message id and resume with `since=<id>` after restarts.
- Sign messages with the gateway's device key if downstream devices require signatures; E2EE
  messages pass through unreadable, which is the point.
