# Browser end-to-end tests

Playwright tests that drive the web console (`apps/site/public/console`) against the real relay
Worker under `wrangler dev`. `serve.mjs` builds the SDK bundle and the site, applies the D1
migrations to a fresh state directory (`e2e/.state`), and starts `wrangler dev` on port 8788,
with Twilio pointed at a local mock (`mock-twilio.mjs`, on the port two above) that records each
SMS and call and lists them at `GET /__calls?to=+1…`.
Each test creates its own account through the local-only `/v1/dev/bootstrap` endpoint.

```bash
pnpm --filter @subetha/e2e exec playwright install chromium   # once
pnpm --filter @subetha/e2e e2e
```

| Variable | Effect |
|---|---|
| `E2E_PORT` | Port for `wrangler dev` (default 8788) |
| `E2E_SKIP_BUILD=1` | Skip the SDK and site builds |
| `E2E_CHROMIUM` | Path to a Chromium binary to use instead of Playwright's download |

Outside CI, a server already listening on the port is reused, so you can keep one running with
`node e2e/serve.mjs` while you iterate.

What's covered:

- the Phase 1 exit criterion: a curl publish reaches the console inbox, and the balance and
  ledger show the debit;
- a message composed in one console arriving in another, and its trace;
- dry runs, which cost one API call and deliver nothing;
- HTTP 402 with the shortfall, from curl and from the console;
- a scoped token made in the console, which can publish only where its scope allows;
- E2EE: a topic key made in the console is wrapped to an enrolled device; the console encrypts
  what it sends and decrypts its inbox, the relay stores ciphertext, and the device opens the key;
- device enrollment: the device-code link opens the Devices tab with the code filled in, the
  approved device publishes with signed requests, and revoking it in the console locks it out;
- escalation through the real delivery queue: an urgent message nobody acks goes to SMS after
  2 s and to a voice call after 4 s (verification codes for both are read back from the mock
  Twilio), a signed keypress callback acks it, and the call-status callback settles the call;
  the same alarm received live by a console is acked over the WebSocket, so both steps are skipped;
- texting in: the Endpoints tab routes a verified number's texts to a topic, a signed inbound
  SMS publishes there, and clearing the topic turns it off;
- the endpoint inspector: a test delivery to a webhook shows the signed request, and the
  in-browser checker verifies its signature with the endpoint's secret;
- the Edge lab's sound transport: a signed envelope modulated into a WAV file is played into
  Chromium as a fake microphone, and the page demodulates, verifies, and shows it (and the Play
  button runs without errors);
- the Edge lab's animated QR, both ways: its canvas decoded here with jsQR until the fountain code
  completes and the signature verifies, and a QR video rendered by the SDK scanned through a fake
  camera (headless Chromium has no BarcodeDetector, so this covers the jsQR fallback).
