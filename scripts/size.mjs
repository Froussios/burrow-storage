#!/usr/bin/env node
// CI size check (NF table): core + memory backend ≤ 12 KB min+gzip, and with
// the offline wrapper (burrow-storage/offline) still ≤ 12 KB; the passkey token
// utility (burrow-storage/passkey) ≤ 2 KB on top of the core. The Firestore
// adapter and lazy SDK have separate 2 KB and 150 KB budgets outside the core
// budget.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const stub = (filter) => ({
  name: "stub",
  setup(b) {
    b.onResolve({ filter }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const FirestoreBackend = 0;",
      loader: "js",
    }));
  },
});

async function measure(name, contents, stubs, limit) {
  const r = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    plugins: stubs ? [stub(stubs)] : [],
    logLevel: "error",
  });
  const code = r.outputFiles[0].contents;
  const gz = gzipSync(code, { level: 9 }).length;
  const ok = gz <= limit;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}: ${(code.length / 1024).toFixed(1)} KB min, ${(gz / 1024).toFixed(2)} KB min+gzip (limit ${(limit / 1024).toFixed(0)} KB)`,
  );
  return { ok, gz };
}

// The core alone: what `burrow({ app, backend: new MemoryBackend(), token })`
// pulls in, minus the Firestore adapter (loaded on demand).
const core = await measure(
  "core + memory backend",
  `export { burrow, generateToken, MemoryBackend, BurrowError } from "./src/index.ts";`,
  /backends\/firestore\.js$/,
  12 * 1024,
);
// D-57: the offline wrapper is optional and keeps the whole 12 KB envelope the
// local-first core had: core + wrapper + memory backend.
const withOffline = await measure(
  "core + offline wrapper + memory backend",
  `export { burrow, generateToken, MemoryBackend, BurrowError } from "./src/index.ts";
   export { offline } from "./src/offline.ts";`,
  /backends\/firestore\.js$/,
  12 * 1024,
);
const withPk = await measure(
  "core + memory backend + passkey token (info)",
  `export { burrow, generateToken, MemoryBackend, BurrowError } from "./src/index.ts";
   export { passkeyToken } from "./src/passkey.ts";`,
  /backends\/firestore\.js$/,
  Infinity,
);
const pkGz = withPk.gz - core.gz;
const pkOk = pkGz <= 2 * 1024;
console.log(
  `${pkOk ? "ok  " : "FAIL"} passkey token (incremental): ${(pkGz / 1024).toFixed(2)} KB min+gzip (limit 2 KB)`,
);
await measure(
  "everything incl. Firestore adapter, excl. SDK (info)",
  `export * from "./src/iife.ts";`,
  /firestore-sdk\.js$/,
  Infinity,
);
// #23: adapters have independent budgets and never consume the core budget.
// These limits leave room above the existing adapter/SDK baseline while
// catching accidental dependencies or eager SDK inclusion.
const firestore = await measure(
  "Firestore adapter (SDK excluded)",
  `export { FirestoreBackend } from "./src/backends/firestore.ts";`,
  /firestore-sdk\.js$/,
  2 * 1024,
);
const sdk = await measure(
  "Firestore SDK (lazy chunk)",
  `export * from "./src/backends/firestore-sdk.ts";`,
  undefined,
  150 * 1024,
);
process.exit(
  core.ok && withOffline.ok && pkOk && firestore.ok && sdk.ok ? 0 : 1,
);
