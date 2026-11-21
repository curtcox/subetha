# APNs relay

APNs (Apple Push Notification service) only speaks HTTP/2. A Cloudflare Worker's outbound
`fetch()` can't be relied on to negotiate HTTP/2 with `api.push.apple.com`, so the SubEtha relay
sends iOS pushes through this small service instead:

```
Worker ──HTTP/1.1──▶ apns-relay ──HTTP/2 (one long-lived connection)──▶ api.push.apple.com
```

It forwards `POST /3/device/{token}` with the APNs headers (`authorization`, `apns-topic`,
`apns-push-type`, `apns-priority`, `apns-expiration`, `apns-collapse-id`, `apns-id`,
`content-type`) and the body unchanged, and returns APNs' status, `apns-id`, and error body.
It holds **no Apple credentials**: the Worker signs the short-lived provider token. A shared
secret in `x-relay-secret` keeps it from being an open relay. Anything else gets 401, 404, 405,
or 413; a stuck upstream gets 504 after 10 seconds.

## Run

Node 22.18 or newer runs the TypeScript sources directly; there are no dependencies.

```bash
RELAY_SECRET=$(openssl rand -hex 24) node src/main.ts
```

Or with Docker (any container host, Cloudflare Containers, or a small VPS):

```bash
docker build -t subetha-apns-relay gateways/apns-relay
docker run -d -p 8080:8080 -e RELAY_SECRET=… subetha-apns-relay
```

| Variable | Default | |
|---|---|---|
| `RELAY_SECRET` | (required) | At least 16 characters. The Worker's `APNS_RELAY_SECRET`. |
| `APNS_UPSTREAM` | `https://api.push.apple.com` | `https://api.sandbox.push.apple.com` for development builds. |
| `PORT` | `8080` | `GET /health` answers `{"ok": true}`. |

Put it behind HTTPS (a load balancer, Cloudflare Tunnel, or the container platform's TLS), then
set the Worker's secrets:

```bash
wrangler secret put APNS_ENDPOINT      # https://apns-relay.example.com
wrangler secret put APNS_RELAY_SECRET  # the same value as RELAY_SECRET
```

## Test

```bash
pnpm --filter @subetha/apns-relay test   # against a local cleartext HTTP/2 server
```
