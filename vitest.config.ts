import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/property/**/*.test.ts", "test/conformance/memory.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
    // Node's Web Storage, as the reference implementation for the sample-app acceptance test.
    execArgv: ["--localstorage-file=node_modules/.cache/burrow-test-localstorage"],
  },
});
