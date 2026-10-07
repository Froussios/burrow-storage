import { defineConfig, devices } from "@playwright/test";

// The demo smoke test (test/smoke, #24), on Chromium.
// After a deploy, against the deployed page (pages.yml does this, and fails the
// run on a failure):
//   BURROW_DEMO_URL=https://froussios.github.io/burrow-storage/ \
//     BURROW_DEMO_COMMIT=<sha> npm run test:smoke
// Before one, against the assembled site/ under the Firestore emulator (ci.yml
// does this):
//   npm run build && node scripts/build-demo.mjs &&
//     node scripts/emulator.mjs "npm run test:smoke"
const url = process.env.BURROW_DEMO_URL;
const port = Number(process.env.E2E_PORT ?? 4173);
if (!url && !process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "set BURROW_DEMO_URL to the deployed demo, or run under the emulator (see playwright.smoke.config.ts)",
  );
}

export default defineConfig({
  testDir: "test/smoke",
  timeout: 240_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: url ? url.replace(/\/?$/, "/") : `http://localhost:${port}/site/`,
    trace: "retain-on-failure",
  },
  ...(url
    ? {}
    : {
        webServer: {
          command: "node scripts/serve.mjs",
          env: { PORT: String(port) },
          url: `http://localhost:${port}/site/index.html`,
          reuseExistingServer: false,
        },
      }),
});
