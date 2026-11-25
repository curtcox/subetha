# Docs samples

Every code sample in the docs lives here as a real file and is pulled into the pages at build time
by `apps/site/build.mjs` (`<!-- include: samples/ts/publish.ts#snippet -->`), so the docs and the
tested code can't drift apart. Don't paste code into `docs/*.md`; add a file here and include it.

| Directory | Contents | How CI checks it |
|---|---|---|
| `ts/` | TypeScript, each exporting `run({ baseUrl, token, topic, fetch, dba })` (`dba` is a stand-in devicebasedauth.org device) | **Run** against the Worker (Miniflare, via `SELF.fetch`) in `workers/api/test/samples.test.ts`, with assertions on the result |
| `curl/` | Shell scripts using `curl` (and `jq`, `websocat` where noted) | `bash -n` in `test/samples.test.ts` |
| `python/` | Python SDK and standard-library snippets | `python -m py_compile` in `test/samples.test.ts` |
| `web/` | HTML and browser JavaScript | `node --check` / page structure in `test/samples.test.ts` |
| `cli/`, `mcp/` | CLI and MCP client snippets | `bash -n`, JSON parse |
| `rust/` | Rust core examples | Built by `cargo test` as `subetha-core` examples (see `sdk/core/Cargo.toml`); run with `cargo run -p subetha-core --example sign_and_encrypt` |

`test/samples.test.ts` also fails if a sample isn't used by any page, if an include marker points
at a missing file, if a TypeScript sample isn't exercised by the Worker test, or if a Rust sample
isn't registered as a cargo example.

## Conventions

- Shell samples read `SUBETHA_TOKEN` and `SUBETHA_URL` (default `https://subetha.us`), and use
  `@me/…` topics: replace `me` with your handle.
- In TypeScript samples, the part shown in the docs sits between `// #region snippet` and
  `// #endregion snippet`; setup outside the region is for the test. `fetch` is passed in so CI
  can route requests to the test Worker; in your own code, leave it out.
- Files starting with `_` are helpers, not samples.

## Running them

```bash
pnpm --filter @subetha/api test     # TypeScript samples against the Worker
pnpm --filter @subetha/samples test # syntax and coverage checks
cargo test -p subetha-core          # builds the Rust example

# Shell samples against a local relay (see curl/local-dev.sh for the token):
SUBETHA_URL=http://localhost:8787 SUBETHA_TOKEN=se_… bash docs/samples/curl/publish.sh
```

## Against a real deployment

`live/live.test.ts` runs the TypeScript samples (all but the ones that create billed resources)
against any deployment over HTTP. The nightly workflow (`.github/workflows/nightly.yml`) runs it
against staging.

```bash
SUBETHA_URL=https://staging.subetha.us SUBETHA_TOKEN=se_… SUBETHA_TOPIC=@samples/nightly \
  pnpm --filter @subetha/samples test:live
```
