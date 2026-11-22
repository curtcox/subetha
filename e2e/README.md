# Browser end-to-end tests

Playwright tests that drive the web console (`apps/site/public/console`) against the real relay
Worker under `wrangler dev`. `serve.mjs` builds the SDK bundle and the site, applies the D1
migrations to a fresh state directory (`e2e/.state`), and starts `wrangler dev` on port 8788.
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
- a scoped token made in the console, which can publish only where its scope allows.
