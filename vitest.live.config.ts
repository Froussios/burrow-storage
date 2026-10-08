import { defineConfig } from "vitest/config";

// Gate 2: your own project, named in the BURROW_FIRESTORE environment variable.
// Never in CI.
export default defineConfig({
  test: {
    include: ["test/conformance/live.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
