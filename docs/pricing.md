# Pricing & billing

SubEtha is **prepaid**. You top up a balance, every action is priced above what it costs to run,
and every action is checked against your balance *before* it runs. There's no subscription, no
free tier, and no bill after the fact. Edge transports (BLE, audio, QR, LAN) never touch the relay
and are free.

## The rules

1. **Prepaid only.** Top up with Stripe Checkout (minimum $5). Each top-up carries a fee of 4.5% +
   $0.35, which covers card processing and fixed costs; the rest becomes credit.
2. **Reserve before acting.** Each action reserves its worst-case cost first, then settles to the
   actual cost (an SMS's real segment count, for example) and releases the rest. If the balance
   can't cover the reservation, the request fails with **HTTP 402** and nothing happens.
3. **Every SKU has a positive margin**, at every volume tier. Prices are generated from measured
   costs in [`pricing/costs.yaml`](https://github.com/curtcox/subetha/blob/main/pricing/costs.yaml),
   and CI fails if any margin drops below 15%. The live table is at `GET /v1/prices`.
4. **State costs rent.** Retained messages, attachments, enrolled devices, verified endpoints, and
   open connections are metered by time.
5. **Volume tiers** lower prices as trailing-12-month top-ups grow (`standard`, `bulk` from $500,
   `volume` from $5,000), without ever crossing the margin floor.

## Prices

Money in the API is integer **micro-dollars** (µ$): 1,000,000 µ$ = $1. The table below is
generated from the price list at build time, so it always matches what the relay charges.

<!-- embed: ../pricing/generated/report.md -->

## Who pays for what

| Action | Paid by |
|---|---|
| Publish (and dry runs, and uploads) | the publisher's token or account |
| Live delivery, push, webhook, email, Slack, SMS, voice, LXMF | the topic owner |
| Reading: polls, stream connections and connection time, attachment downloads | the topic owner |
| Message retention and attachment storage | the topic owner (retention), the publisher (attachment storage) |
| Anonymous publishes (when the topic allows them) | the topic owner, within the topic's anonymous caps |
| Endpoint verification codes | the account adding the endpoint |
| Inbound email and SMS | the owner of the receiving topic |

## Balance, ledger, and top-ups

<!-- include: samples/curl/billing.sh -->

### Auto-recharge

Optional, and not a subscription: top up once with `"save_card": true` in the checkout request,
then turn it on with `PATCH /v1/account`:

```json
{ "auto_recharge": { "threshold_usd": 2, "amount_usd": 20 } }
```

When the balance drops below the threshold, the saved card is charged `amount_usd` (same fee as
any top-up). A declined charge turns auto-recharge off. `{"auto_recharge": null}` turns it off.

### Ledger

The ledger is append-only: `topup`, `reserve`, `settle`, `release`, `refund`, and `adjust`
entries, journaled and reconciled nightly against Stripe. Refunds and chargebacks are deducted
from the balance (a chargeback also recovers the dispute fee where possible).

## 402 Payment Required

```json
{ "error": "insufficient_balance", "http": 402, "message": "…", "shortfall_usd_micros": 1234 }
```

- `insufficient_balance`: the payer can't cover the worst-case cost. `shortfall_usd_micros` says
  how much more is needed. `"payer": "topic_owner"` means the *topic owner's* balance is short
  (for delivery), not yours.
- `no_funded_owner`: an anonymous publish to a topic whose owner can't pay.

Clients should treat 402 as permanent until someone tops up; retrying won't help.

## Caps and holds

Several independent limits stop spending before it surprises anyone. Each returns
`403 spend_cap_exceeded` when it would be crossed:

| Limit | Set with |
|---|---|
| Per token, per day and in total | `daily_cap_usd`, `total_cap_usd` on [`POST /v1/tokens`](tokens.md) |
| Per topic, per day (owner-side spend, including reads) | topic policy `daily_cap_micros` |
| Per message | topic policy `max_cost_per_message_micros`; per publish `X-Max-Cost` |
| Anonymous publishing, per topic per day | topic policy `anon_daily_cap_micros` (default $1) |
| Per account, per day | `PATCH /v1/account {"daily_cap_micros": …}` |
| **New-funds hold** | automatic: until your first top-up is 7 days old, SMS and voice spend is capped at $5 in total |

Plus a kill switch at every level: `paused` on a topic policy or on the account.

## Running out

With a zero balance, every paid action fails with 402 before it runs. Rent for devices and
endpoints is charged daily; when it can't be paid the account is marked **frozen** (records are
kept). After 30 days frozen, its endpoints and subscriptions are deleted and its devices revoked.
A top-up before then unfreezes it at the next daily run.

## Traces

Every message has a trace, visible only to the topic owner: the route plan, what was dropped and
why, each delivery attempt and its result, acks, and the µ$ charged for each step.

<!-- include: samples/ts/trace.ts#snippet -->

## Estimating before you spend

`X-Dry-Run: 1` on any publish returns the plan and a worst-case price without sending anything
([Dry runs](publishing.md#dry-runs)). `subetha cost <topic>` does the same from the CLI, and the
MCP tool `estimate_cost` does it for agents.
