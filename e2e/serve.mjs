// Starts the relay for the e2e tests: builds the SDK bundle and the site, applies the D1 migrations
// to a fresh local state directory, then runs `wrangler dev` on the given port.
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockTwilio } from "./mock-twilio.mjs";

const port = process.argv[2] ?? "8788";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(root, "workers/api");
const state = join(root, "e2e/.state");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: process.env.CI ?? "1" };
const run = (args, cwd = root) => execFileSync("pnpm", args, { cwd, env, stdio: "inherit" });

if (!process.env.E2E_SKIP_BUILD) {
  run(["--filter", "@subetha/sdk", "build"]);
  run(["--filter", "@subetha/site", "build"]);
}
rmSync(state, { recursive: true, force: true });
run(["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state], api);

// Twilio is a local mock (mock-twilio.mjs) so SMS/voice escalation runs end to end.
const twilioPort = Number(port) + 2;
const twilio = startMockTwilio(twilioPort);
const vars = {
  BASE_URL: `http://localhost:${port}`,
  TWILIO_API_BASE: `http://localhost:${twilioPort}`,
  TWILIO_ACCOUNT_SID: "ACe2e",
  TWILIO_AUTH_TOKEN: "e2e-twilio-token",
  TWILIO_FROM: "+15005550006",
  // Lets tests post signed Stripe webhooks (payments.spec.ts).
  STRIPE_WEBHOOK_SECRET: "whsec_e2e",
};
const dev = spawn("pnpm", ["exec", "wrangler", "dev", "--port", port, "--persist-to", state, ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: api, env, stdio: "inherit" });
const stop = () => { twilio.close(); dev.kill("SIGTERM"); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
dev.on("exit", (code) => process.exit(code ?? 0));
