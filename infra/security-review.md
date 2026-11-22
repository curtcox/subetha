# Security review: relay Worker (November 2026)

Scope: `workers/api/src`, against the invariants in PLAN §5, §7–§9: no unpaid usage, a balance
that never goes negative, scoped tokens, only owners subscribe paid endpoints, verified
endpoints, and authenticated webhooks and devices. Regression tests are in
`workers/api/test/security-review.test.ts`. Each one fails on the code before the fix.

## Fixed

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | High | The anonymous daily cap counted only live deliveries and the publish. Queued SMS, voice, email, and webhook reservations were uncapped, so anonymous publishers on a `public_publish` topic could spend the owner's balance on paid deliveries. | The cap counts everything the owner pays for an anonymous publish, including retention (`durable/topic.ts`). |
| 2 | Medium | Signed messages are accepted for 7 days but stored only for the retention period. A captured signed message could be replayed after it was purged, and the owner paid again. | Signed ids are remembered for the whole acceptance window. A replay gets 409. |
| 3 | Medium | Token and OAuth-client spend caps didn't apply to polls or stream backlogs. | `capTokenRead` tracks read spend against the caller token's caps. |
| 4 | Medium | The topic daily cap was read before cross-DO awaits and written after them, so concurrent publishes could exceed it. Read-side spend had the same race. | The counters are checked and incremented with no await in between, and rolled back on failure. |
| 5 | Medium | `/v1/device/code` (unauthenticated) stored unbounded `capabilities`, and codes were never deleted. | Size limits, one pending code per device, and the daily cron deletes expired codes. |
| 6 | Medium | `POST /v1/devices` registered any device id without proof of key possession, and device ids are public. Approving a device held by another account reported success. | The enrollment proof is required. Approving returns 409 and leaves the code pending. |
| 7 | Low | The 5-attempt limit on endpoint verification was check-then-increment. | One conditional `UPDATE … WHERE verify_attempts < 5`. |
| 8 | Low | Web Push endpoints skipped the webhook host checks and followed redirects. | Same host checks as webhooks, and `redirect: "manual"`. |
| 10 | Low | Repeating an `Idempotency-Key` was free and not rate limited. | Charged as an API request, and rate limited when anonymous. |
| 11 | Low | `frozen_since` was set by the rent cron but never read. | A frozen account's endpoints drop out of delivery plans until it pays again. |
| 12 | Medium | Device request signatures (`subetha-req-v1`) didn't cover content or routing headers (`X-Title`, `X-Priority`, `X-Route-Mode`, `X-Max-Cost`, `X-Allow`/`X-Deny`, `Idempotency-Key`, `Content-Type`, …). Anyone relaying a captured request could change its content, cost, and routing within the 5-minute single-use window. | `subetha-req-v2` (spec §8.1) signs every header named in `X-Device-Signed-Headers`. The relay rejects a signed request that carries a covered header (every header the ntfy parser reads, plus `Content-Type` and `Idempotency-Key`) without signing it. A test checks that every header `ntfy.ts` reads is covered. All SDKs (TS, Rust core, Kotlin, Swift, Dart, React Native typings) sign v2 and pass the shared vectors in `spec/vectors/requests.json`. v1 is still accepted only for requests with no covered header. |
| 13 | Low | The one-code-per-destination-per-hour throttle on verification messages used KV, which is eventually consistent, so a burst (from one account or several) could send more than one code to the same number or address. | A conditional upsert into the D1 `verify_sends` table claims the hour atomically (`claimVerifySend`). The claim is given back if the account can't pay; the daily cron drops old rows. |

## Open

- **To confirm on staging:**
  - Does Cloudflare Email Routing reject spoofed senders (SPF/DMARC)? `email_senders` trusts the
    envelope `From`.
  - What shape are Clerk's OAuth access tokens? `clerk.ts` treats a JWT with neither
    `typ: at+jwt` nor `client_id` as a full session.
  - Should org accounts check roles? Today every org member gets admin rights on the org
    account.
