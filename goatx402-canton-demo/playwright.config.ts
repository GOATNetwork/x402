// Playwright config for the Task 13 E2E suite. Drives the production
// `pnpm preview` build (NOT `pnpm dev`) so the test exercises the same
// bundle a deployed artefact would expose — resolves §8.3 E2 P2.
//
// `VITE_PAYER_TOKEN` is sourced from the gitignored token file
// `scripts/init-custodial-keys.sh` produced; the fixture runner reads it
// from `process.env.PAYER_TOKEN` so CI can inject it via `e2e-smoke.sh`.
//
// Each test starts a Vite preview server on port 4173 and runs the SPA
// against the real backend (facilitator + merchant) the caller has already
// brought up via `make canton-up && scripts/e2e-smoke.sh`.

import { defineConfig, devices } from "@playwright/test";

const previewPort = Number.parseInt(process.env.CLIENT_WEB_PORT ?? "4173", 10);
const previewURL = `http://127.0.0.1:${previewPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: previewURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Build first, then serve the production bundle via `pnpm preview`. The
    // command intentionally chains `pnpm build` so a stale `dist/` is never
    // exercised in CI.
    command: "pnpm build && pnpm preview --port " + previewPort + " --host 127.0.0.1",
    url: previewURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // The token + party + URLs are read by the SPA at build time. Tests
      // assume the e2e harness has populated these via the gitignored
      // PAYER_TOKEN_FILE — see Task 14 wiring.
      VITE_PAYER_TOKEN: process.env.VITE_PAYER_TOKEN ?? process.env.PAYER_TOKEN ?? "",
      VITE_PAYER_PARTY: process.env.VITE_PAYER_PARTY ?? process.env.PAYER_PARTY ?? "",
      VITE_FACILITATOR_URL:
        process.env.VITE_FACILITATOR_URL ?? "http://localhost:8080",
      VITE_MERCHANT_URL:
        process.env.VITE_MERCHANT_URL ?? "http://localhost:7070",
      VITE_RESOURCE_PATH: process.env.VITE_RESOURCE_PATH ?? "/resource",
      VITE_SOURCE_HOLDING_CID: process.env.VITE_SOURCE_HOLDING_CID ?? "",
    },
  },
});
