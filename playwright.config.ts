import { defineConfig, devices } from "@playwright/test";

// Browser tests run under the Firestore emulator: `npm run test:e2e` (scripts/emulator.mjs
// exports FIRESTORE_EMULATOR_HOST to Playwright, its web server and the tests).
const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `node scripts/serve.mjs`,
    env: { PORT: String(port) },
    url: `http://localhost:${port}/test/e2e/harness.html`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
