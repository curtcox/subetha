# SubEtha Terms of Service (DRAFT)

_Last updated: [DATE]. Draft for legal review._

These Terms govern your use of subetha.us, its APIs, SDKs, gateways, and related services
(the "Service"), operated by [ENTITY] ("we"). By creating an account or using the API you agree
to these Terms and to the [Acceptable Use Policy](aup.md).

## 1. Accounts
You need an account to use relay features. You're responsible for your account, your API tokens,
your devices, and everything done with them. Keep tokens secret; revoke them in the console if
they leak. Organizations may share an account; the person who creates it confirms they can bind
the organization.

## 2. Prepaid balance
- The Service is prepaid. You add funds by card through Stripe. There is no subscription; optional
  auto-recharge tops up your balance when it falls below a threshold you choose.
- A top-up fee (shown before you pay) covers card processing and fixed costs.
- Every metered action is priced in advance (see the pricing page and `X-Dry-Run` estimates) and is
  checked against your balance **before** it runs. If your balance can't cover an action, it is
  refused (HTTP 402); we never bill you after the fact.
- Prices may change for future usage with notice on the pricing page. Usage already performed is
  never repriced.
- Stored resources (retained messages, attachments, devices, verified endpoints) accrue daily rent.
  If your balance can't pay it, resources are frozen and, after [30] days and notice to your account
  email, deleted.
- **Refunds:** [TO DECIDE — PLAN open question 3: either "unused balance is refundable on request
  minus processing fees" or "balance is non-refundable service credit".] Chargebacks of legitimate
  top-ups may lead to suspension; we recover dispute fees from remaining balance where possible.
- New funds may be subject to limits on SMS and voice spend for a period after your first top-up.

## 3. Your content
You keep all rights to messages and attachments you send ("Content"). You grant us the limited
rights needed to store, route, and deliver Content through the transports your policies allow
(including third-party providers such as push services, email, Slack, and SMS/voice carriers).
End-to-end encrypted Content is never readable by us.

## 4. Acceptable use
You must follow the [Acceptable Use Policy](aup.md). In particular, you may send SMS, voice, or
email only to recipients who have consented, and we require recipients to verify paid endpoints.

## 5. Third-party services
Delivery depends on providers we don't control (Cloudflare, Stripe, Clerk, Apple, Google, Slack,
Twilio, email providers, Reticulum networks). Their terms may apply to you when you connect them
(for example, installing the Slack app). Edge transports (Bluetooth, audio, QR, LAN) run on your
devices; we don't operate them.

## 6. Availability and changes
We aim for high availability but provide the Service "as is". Delivery over any transport is best
effort; use multiple transports and acknowledgements (escalation) for important alerts. **Do not
use the Service as your only means of life-safety notification.** We may change or discontinue
features with reasonable notice.

## 7. Suspension and termination
We may suspend accounts or tokens that violate these Terms or the AUP, endanger the Service, or
create legal risk, and we may block destinations (for example, numbers flagged for SMS pumping).
You may close your account at any time; [refund terms per §2].

## 8. Disclaimers and limitation of liability
[Standard disclaimers and a liability cap — for example, the greater of the amount you paid in
the 12 months before the claim or US$100 — to be drafted by counsel.]

## 9. Indemnity
[To be drafted by counsel: you indemnify us for claims arising from your Content and from messages
sent to recipients who didn't consent.]

## 10. Governing law
These Terms are governed by the laws of [JURISDICTION]. [Dispute resolution clause.]

## 11. Contact
[ENTITY], [ADDRESS], [CONTACT EMAIL].
