#!/usr/bin/env node
// CI size check (NF table): core + memory backend ≤ 12 KB min+gzip; the passkey
// backup (burrow-storage/passkey) ≤ 2 KB on top of it. The Firestore SDK is
// lazy-loaded and not counted.
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

// The core alone: what `burrow({ app, backend: new MemoryBackend() })` pulls
// in, minus the Firestore adapter (loaded on demand).
const core = await measure(
  "core + memory backend",
  `export { burrow, MemoryBackend, BurrowError } from "./src/index.ts";`,
  /backends\/firestore\.js$/,
  12 * 1024,
);
const withPk = await measure(
  "core + memory backend + passkey backup (info)",
  `export { burrow, MemoryBackend, BurrowError } from "./src/index.ts";
   export { passkeyBackup } from "./src/passkey.ts";`,
  /backends\/firestore\.js$/,
  Infinity,
);
const pkGz = withPk.gz - core.gz;
const pkOk = pkGz <= 2 * 1024;
console.log(
  `${pkOk ? "ok  " : "FAIL"} passkey backup (incremental): ${(pkGz / 1024).toFixed(2)} KB min+gzip (limit 2 KB)`,
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
process.exit(core.ok && pkOk && firestore.ok && sdk.ok ? 0 : 1);
