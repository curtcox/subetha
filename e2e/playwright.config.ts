// Console end-to-end tests. `pnpm --filter @subetha/e2e e2e` builds the SDK and site, starts the
// relay under `wrangler dev` with fresh local state (serve.mjs), and drives the console in Chromium.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8788);
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "off",
    // Chromium installed outside the project (e.g. a preinstalled browser) can be used instead.
    launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node serve.mjs ${PORT}`,
    url: `${BASE_URL}/v1/status`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
