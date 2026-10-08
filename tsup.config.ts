import { defineConfig } from "tsup";

// In the script-tag build the adapter loads the SDK from burrow-firestore.js at
// runtime (src/iife.ts), so the static `import("./firestore-sdk.js")` must not
// pull Firebase in.
const stubSdk = {
  name: "stub-firestore-sdk",
  setup(build: { onResolve: Function; onLoad: Function }) {
    build.onResolve(
      { filter: /firestore-sdk\.js$/ },
      (args: { path: string }) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export {}",
      loader: "js",
    }));
  },
};

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      passkey: "src/passkey.ts",
      firestore: "src/backends/firestore.ts",
      "setup-check": "src/setup/check.ts",
    },
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: true,
    treeshake: true,
    external: ["firebase/app", "firebase/firestore"],
  },
  {
    // Single-file browser build: global `Burrow` (burrow.min.js).
    entry: { burrow: "src/iife.ts" },
    format: ["iife"],
    platform: "browser",
    globalName: "Burrow",
    target: "es2022",
    minify: true,
    sourcemap: true,
    outExtension: () => ({ js: ".min.js" }),
    esbuildPlugins: [stubSdk],
  },
  {
    // Self-hosted Firestore SDK for script-tag users (SEC-4: no third-party
    // script hosts). A classic script setting a global, so it also loads from
    // file:// where module imports are blocked (NF-1).
    entry: { "burrow-firestore": "src/backends/firestore-sdk.ts" },
    format: ["iife"],
    globalName: "BurrowFirestoreSdk",
    platform: "browser",
    target: "es2022",
    minify: true,
    noExternal: [/firebase/],
    outExtension: () => ({ js: ".js" }),
  },
]);
