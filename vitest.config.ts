import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      "test/property/**/*.test.ts",
      "test/conformance/memory.test.ts",
      "test/conformance/worker.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
  },
});
