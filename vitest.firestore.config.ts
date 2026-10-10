import { defineConfig } from "vitest/config";

// Runs the backend conformance suite against the Firestore emulator (via
// scripts/emulator.mjs).
export default defineConfig({
  test: {
    include: [
      "test/conformance/firestore.test.ts",
      "test/conformance/reaper.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    testTimeout: 30_000,
  },
});
