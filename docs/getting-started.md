# Getting started

You need an account with a little credit, and a token. Then publishing is one HTTP request.

## 1. Get a token

1. Sign in at [subetha.org/console](https://subetha.org/console/) and pick a **handle**. Your
   topics live under `@handle/…`.
2. Top up your balance (minimum $5). See [Pricing & billing](pricing.md).
3. Create a token under **Tokens**. For scripts, scope it narrowly and give it a daily cap (see
   [Tokens & policies](tokens.md)).

```bash
export SUBETHA_TOKEN=se_xxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Prefer to try it locally first? Run the relay on your machine and get a funded account
without signing up:

<!-- include: samples/curl/local-dev.sh -->

## 2. Publish

<!-- include: samples/curl/publish.sh -->

The response is the stored message, with its `id`. The `X-Cost-Micros` response header says what
you were charged, in micro-dollars (µ$; 1,000,000 µ$ = $1).

Topics are created on first publish in your own namespace (`@yourhandle/anything`) or as secret
`t_…` topics (see [Concepts](concepts.md#topics)).

## 3. Subscribe

In another terminal:

<!-- include: samples/curl/subscribe-json.sh -->

Publish again and the message appears on the stream immediately. Or open
`https://subetha.org/@me/backups` in a browser: topic URLs open in the web console.

## 4. Use an SDK

The TypeScript SDK (`npm i @subetha/sdk`) handles reconnects, dedupe, acks, signatures, and
encryption. It runs in browsers, Node 18+, Deno, Bun, and Workers.

<!-- include: samples/ts/publish.ts#snippet -->

<!-- include: samples/ts/subscribe.ts#snippet -->

There are also a [Python SDK, a Rust core, a CLI, and drop-in web components](sdks.md).

## Built-in tools

- [Pricing calculator](/tools/pricing.html): a month of usage, priced from the same table the
  relay charges from, and the top-up that covers it.
- [Route simulator](/tools/simulator.html): which transports a message would use, in what order,
  and at what cost. It runs the relay's planner in your browser, so it needs no account.
- In the [console](https://subetha.org/console/): **Copy as** curl, JavaScript, Python, Swift,
  Kotlin, or Dart for any message you compose; **Simulate route & cost** (a dry run against your
  real topic); a token builder; a trace viewer; and an **API explorer** that sends any operation
  in the [OpenAPI document](/openapi.yaml) with your credential.

## Next

- Deliver to phones, email, Slack, or SMS: [Transports](transports.md).
- Control cost and routing per message: [Publishing](publishing.md#routing-and-cost).
- Let an AI agent publish and wait for replies: [Agents](agents.md).
