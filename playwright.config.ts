import { defineConfig, devices } from "@playwright/test";

const webPort = 3100;
const apiPort = 4100;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium-mock", testIgnore: /real-ledger\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] } },
    { name: "real-api-ledger", testMatch: /real-ledger\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `E2E_API_PORT=${apiPort} E2E_WEB_ORIGIN=http://127.0.0.1:${webPort} node tests/e2e/support/mock-api.mjs`,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
    },
    {
      command: `AUTHENTI8_E2E_ORIGIN=http://127.0.0.1:${webPort} AUTHENTI8_E2E_API_ORIGIN=http://127.0.0.1:${apiPort} npm run dev -w @authenti8/web -- --hostname 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
  outputDir: "test-results/playwright",
});
