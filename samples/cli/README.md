# CLI samples

- `doorbell-curl.sh`: the doorbell flow with plain `curl`: JSON stream subscription,
  ntfy-header publish, dry-run cost, JSON publish with an idempotency key and a cost cap, ack,
  and poll.
- `doorbell-cli.sh`: the same flow with the `subetha` CLI (`npx subetha`, from `sdk/js`).

```bash
SUBETHA_TOKEN=se_... samples/cli/doorbell-curl.sh @me/doorbell
samples/cli/doorbell-cli.sh se_... @me/doorbell
SUBETHA_URL=http://localhost:8787 samples/cli/doorbell-cli.sh se_dev...   # local relay
```
