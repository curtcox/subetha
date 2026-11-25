# SubEtha Reticulum/LXMF gateway

Bridges [Reticulum](https://reticulum.network) / [LXMF](https://github.com/markqvist/LXMF) to
SubEtha topics. Each mapped topic gets its own LXMF address, so anyone on the mesh, using Sideband,
NomadNet, MeshChat, or any other LXMF client, can publish to it and subscribe to it without IP
connectivity to the relay.

```
 Sideband / NomadNet ──LXMF──▶ topic's LXMF address ─┐                 ┌──▶ web, push, email, SMS …
                                                      ├─ gateway ─HTTP─┤
 Sideband / NomadNet ◀─LXMF── (for /subscribe'd peers)┘                 └─── any SubEtha publisher
```

## How it works

| Direction | What happens |
|---|---|
| LXMF → topic | A message sent to a topic's LXMF address is published to the topic. The LXMF title becomes the message `title`, the content becomes `message`, and the sender's LXMF address goes in the extension field `lxmf_from`. |
| topic → LXMF | Every message on the topic goes, as an LXMF message from the topic's address, to each LXMF peer that sent it `/subscribe`. |
| Commands | `/subscribe`, `/unsubscribe`, `/ack <id>`, `/status`, `/help`, sent as the message content. Start a message with `//` to publish text that begins with `/`. |

Loop and duplicate protection:

- A message that came in over LXMF is never sent back to the peer that sent it. The gateway picks
  the message id before publishing, so it can recognize the relay's echo even when the echo
  arrives before the publish response. It also skips the peer named in `lxmf_from`, which covers
  restarts and messages bridged by another gateway.
- Relay messages are deduped by message id (spec §6). Inbound LXMF messages are deduped by LXMF
  message hash.
- The relay cursor (last message id) is saved, so after a restart the gateway catches up with
  `since=<last id>` and doesn't redeliver.

End-to-end encrypted SubEtha messages are delivered as a short notice, because the gateway never
holds topic keys. Attachments and click URLs are appended as links.

## Run it

```bash
pip install -e sdk/python -e "gateways/reticulum[rns]"   # from the repo root
cp gateways/reticulum/gateway.example.toml gateway.toml   # edit topics
export SUBETHA_TOKEN=se_...                               # token with publish+subscribe on the topics
subetha-reticulum --config gateway.toml
```

On startup it prints each topic's LXMF address:

```
@alice/doorbell  ->  LXMF <9ecc3b10bc264d1543b9be044d6fda7a>
```

Add that address as a contact in your LXMF client, send `/subscribe`, and publish to the topic from
anywhere else (`curl -d hi https://subetha.us/@alice/doorbell`).

Reticulum itself is configured as usual: by default `~/.reticulum/config`, or the directory named by
`reticulum_config_dir`. The gateway needs at least one interface that reaches the mesh you want to
serve (a local RNode, a `TCPClientInterface` to a transport node, `AutoInterface` on a LAN, …).

### Configuration

See [`gateway.example.toml`](gateway.example.toml). The main keys:

| Key | Meaning |
|---|---|
| `relay_url` | Relay base URL. Default `https://subetha.us`. |
| `token` / `token_env` | API token, or the environment variable holding it (default `SUBETHA_TOKEN`). |
| `data_dir` | LXMF identities (one per topic), LXMF router storage, and `state.json` (subscribers, cursors). **Persist it**: losing it changes every topic's LXMF address. |
| `reticulum_config_dir` | Reticulum config directory. |
| `announce_interval` | Seconds between announces of every topic address (0 = only at startup). |
| `delivery_method` | `direct`, `opportunistic`, or `propagated` (with `propagation_node`). |
| `health_port` | Serves `GET /health` with the topic → address map, and `POST /deliver` when `deliver_secret` is set. |
| `deliver_secret` (or env `SUBETHA_DELIVER_SECRET`) | Shared secret with the relay's `LXMF_GATEWAY_SECRET`. The relay pushes deliveries for `lxmf` endpoints (any LXMF address an account has subscribed to a topic) to `POST /deliver`, HMAC-signed as `X-SubEtha-Signature: t=…,v1=…`. They are sent from the topic's destination if it is mapped here, otherwise from the first mapped topic. |
| `[[topics]]` | `topic`, `name` (announced display name), `publish` (LXMF → topic), `deliver` (topic → LXMF), `allow` (LXMF addresses allowed to use it; empty means anyone). |

The gateway publishes with its own token, so the token's account pays for what mesh users publish.
Scope the token to the bridged topics, set a spend cap on it, and use `allow` on topics that
shouldn't be open to the whole mesh. On allow-listed topics a sender must be verified (LXMF signature
checked against a known identity); otherwise the gateway asks the sender to announce and retry.

## Docker

Build from the repository root, since the image also installs the local Python SDK:

```bash
docker build -f gateways/reticulum/Dockerfile -t subetha-reticulum .
docker run -d --name subetha-reticulum --restart unless-stopped \
  -e SUBETHA_TOKEN=se_... \
  -v subetha-reticulum-data:/data \
  -v "$PWD/gateway.toml:/config/gateway.toml:ro" \
  -v "$PWD/reticulum:/config/reticulum:ro" \
  subetha-reticulum
```

The image's defaults (`docker/gateway.toml`, `docker/reticulum/config`) read the token from
`SUBETHA_TOKEN`, keep state in `/data`, serve health on port 8080, and connect out to a public
Reticulum transport node over TCP. Replace both with your own topics and interfaces. For a local
RNode, pass the serial device through (`--device /dev/ttyUSB0`) and add an `RNodeInterface`.

### Cloudflare Containers

The hosted gateway runs as a Cloudflare Container started by a Worker. Notes for that setup:

- Containers accept only HTTP from their Worker, so use outbound interfaces
  (`TCPClientInterface` to a transport node). `health_port = 8080` gives the Worker something to
  route to.
- Container disks are ephemeral. Keep `/data` somewhere durable (restore it at start from R2, for
  example). If you don't, topic addresses change on every cold start.
- Set a long `sleepAfter`, or ping `/health` from a Cron Trigger. A sleeping container can't
  receive LXMF messages.

A small VPS with a persistent disk is the simpler option.

## Bring your own gateway

Anyone can run this gateway against `subetha.us` (or their own relay). It talks to the relay only
through the public ntfy-compatible HTTP API, so it needs no special access:

1. Create (or pick) topics and an API token that can publish and subscribe to them. A token scoped
   to just those topics, with a spend cap, is safest.
2. Run the gateway as above, on any machine whose Reticulum interfaces reach your mesh: a Raspberry
   Pi with an RNode, a home server on the LAN, or a VPS connected to a transport node.
3. Share the printed LXMF addresses with mesh users. They're stable as long as `data_dir` persists.

Several gateways can bridge the same topic, for example one per mesh island. Each one has its own
LXMF addresses and subscribers. Messages that come in through one gateway carry `lxmf_from`, so
other gateways won't send them back to their author.

## Development

The bridge logic (`Bridge`) is pure and talks to two ports: `LxmfPort` and `RelayPort`. The real
adapters are `RnsLxmfPort` (imports `RNS`/`LXMF` lazily) and `HttpRelayPort` (the SubEtha Python
SDK, with NDJSON subscriptions running in threads). Tests use fake ports and don't need Reticulum:

```bash
pip install -e "sdk/python[test]" -e "gateways/reticulum[test]"
pytest gateways/reticulum
```
