# SubEtha Privacy Policy (DRAFT)

_Last updated: [DATE]. Draft for legal review._

This policy explains what [ENTITY] collects when you use SubEtha, why, and for how long. It is
written to match how the system actually works (see PLAN.md and the source code).

## What we collect

| Data | Why | Retention |
|---|---|---|
| Account: linked devicebasedauth.org account id (or Clerk user/org id), email, handle | sign-in, billing receipts, notices | while the account exists |
| Billing: Stripe customer/session ids, amounts, ledger entries | prepaid balance, reconciliation, tax | as required by law (typically 7 years) |
| API tokens (hashed), devicebasedauth.org device and credential ids, attached device public keys and names, last-seen times | authentication | until revoked or deleted |
| Endpoints you add: email addresses, phone numbers, webhook URLs, push tokens, Slack channel ids, LXMF addresses | delivering messages you route there | until you delete them, or [30] days after a frozen account's grace period |
| Messages and attachments | store-and-forward delivery | until the message expires (topic retention, default 12 hours, max 30 days) |
| Message traces (route, costs, delivery results, acks) | showing the topic owner what happened | until the message expires |
| Audit log of account changes | security | [1 year] |
| Request logs and metrics (IP address, user agent, timing) | abuse prevention, rate limiting, debugging | [30 days] |

We don't sell personal data and don't use Content for advertising or model training.

## End-to-end encryption
If a topic uses E2EE, message bodies, titles, and attachments are encrypted on your devices; we
only see metadata needed for routing (topic, id, time, priority, tags, sender device id if
signed).

## Who processes data for us
Cloudflare (hosting, storage, email routing), Stripe (payments), devicebasedauth.org (sign-in and device credentials), Clerk (sign-in, where offered), and — only for
transports you enable — Apple/Google push services, Slack, Twilio (SMS/voice), email providers
(Cloudflare Email Service or Amazon SES), and the Reticulum network via our gateway. [List with
links to each processor's privacy policy and DPA.]

## Visibility between users
Devices never learn which other devices subscribe to a topic or how they're reached. Topic owners
see traces of their own topics, including masked destination addresses.

## Your rights
You can export or delete your data from the console or by contacting [CONTACT EMAIL]. [GDPR/CCPA
rights, legal bases, and international transfer language to be completed by counsel.]

## Children
The Service is not directed to children under 13 (or the age required by local law).

## Changes and contact
We'll post changes here and notify account emails of material changes. Contact: [CONTACT EMAIL].
