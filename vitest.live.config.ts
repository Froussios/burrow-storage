import { defineConfig } from "vitest/config";

// Gate 2: the live shared project. Never part of `npm test`.
export default defineConfig({
  test: {
    include: ["test/conformance/live.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
