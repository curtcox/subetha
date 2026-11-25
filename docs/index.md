# SubEtha docs

SubEtha is a hosted pub/sub relay. You publish a message to a **topic**, and every device
subscribed to that topic gets it over whatever path works: a WebSocket, a phone push, a webhook,
email, Slack, SMS, a phone call, an MCP agent, or a Reticulum mesh. Publishers never need to know
who is listening or how they're reached.

It speaks ntfy's wire protocol, so this works:

<!-- include: samples/curl/publish.sh -->

## Where to start

| If you want to… | Read |
|---|---|
| Send your first message in two minutes | [Getting started](getting-started.md) |
| Understand topics, devices, endpoints, routing, and who pays | [Concepts](concepts.md) |
| Publish with headers, JSON, signatures, E2EE, attachments, retries, or dry runs | [Publishing](publishing.md) |
| Receive as JSON, SSE, raw text, WebSocket, or by polling | [Subscribing](subscribing.md) |
| Deliver to push, email, Slack, SMS, voice, webhooks, or LXMF | [Transports](transports.md) |
| Know what it costs and how the balance works | [Pricing & billing](pricing.md) |
| Hand out safe credentials and set topic rules | [Tokens & policies](tokens.md) |
| Enroll phones, Pis, browsers, and CLIs as devices | [Devices](devices.md) |
| Use the SDKs (TypeScript, Python, Swift, Kotlin, Dart, React Native, Rust core), the CLI, or web components | [SDKs & CLI](sdks.md) |
| Connect an AI agent | [Agents (MCP, llms.txt)](agents.md) |
| Run locally, or bridge your own transport | [Self-hosting & gateways](self-hosting.md) |
| Look up a route, header, or error code | [API reference](api.md) |

## Principles

- **Topics, not addresses.** Devices only know topic names (and optionally keys).
- **The relay picks the route.** Transport selection, fallback, escalation, retries, and dedupe
  happen in the relay and the SDKs.
- **The owner stays in control.** Allow-lists, spend caps, rate limits, quiet hours, and a
  per-message trace showing the route and its cost.
- **No surprises on the bill.** Every action is prepaid and checked against your balance before it
  runs. `X-Dry-Run: 1` tells you the price first.

Every code sample in these docs is a real file under
[`docs/samples/`](https://github.com/curtcox/subetha/tree/main/docs/samples) and runs in CI, so the
snippets you copy are known to work.
