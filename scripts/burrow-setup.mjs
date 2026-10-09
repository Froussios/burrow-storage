#!/usr/bin/env node
// FS-10 (D-51): the packaged live rules check. Setup steps live in
// docs/firestore-setup.md and firebase/SETUP-AGENT.md.
const [target, ...args] = process.argv.slice(2);

const usage = "usage: npx burrow-setup check '<config JSON>'";

if (target === "check") {
  let config;
  try {
    config = JSON.parse(args[0]);
    if (
      args.length !== 1 ||
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      ["apiKey", "projectId"].some(
        (field) => typeof config[field] !== "string" || !config[field].trim(),
      ) ||
      (config.appId !== undefined &&
        (typeof config.appId !== "string" || !config.appId.trim())) ||
      Object.keys(config).some(
        (field) => !["apiKey", "projectId", "appId"].includes(field),
      )
    )
      throw new Error();
  } catch {
    console.error(
      "Supply your own config JSON with apiKey, projectId and optional appId only.",
    );
    process.exit(1);
  }
  if (process.env.CI) {
    console.error("Live setup checks must not run in CI.");
    process.exit(1);
  }
  if (
    Number(process.versions.node.split(".")[0]) < 20 ||
    !globalThis.crypto?.subtle
  ) {
    console.error(
      "The check command needs Node 20 or newer with native WebCrypto.",
    );
    process.exit(1);
  }
  console.log(
    "Checking the caller-named live project. Writes one throwaway document; client rules forbid deleting it.",
  );
  console.log(
    "This checks rules, not Spark billing or enabled products. A restricted browser key may block Node requests.",
  );
  const timeout = setTimeout(() => {
    console.error("FAIL timeout: check did not finish within 60 seconds.");
    process.exit(1);
  }, 60_000);
  try {
    const { checkFirestore, SetupCheckError } =
      await import("../dist/setup-check.js");
    try {
      await checkFirestore(config, (message) => console.log(message));
    } catch (error) {
      if (error instanceof SetupCheckError) console.error(error.message);
      else console.error("FAIL setup-check: unexpected-result");
      process.exitCode = 1;
    }
  } catch {
    console.error(
      "The packaged check needs a build and the optional Firebase peer: npm install firebase. See firebase/SETUP-AGENT.md.",
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
  process.exit(process.exitCode ?? 0);
}

if (target === "firestore") {
  console.error(
    "burrow-setup firestore was removed. Human steps: https://github.com/Froussios/burrow-storage/blob/main/docs/firestore-setup.md\nAgents: follow firebase/SETUP-AGENT.md in this package.",
  );
  process.exit(1);
}

console.log(usage);
process.exit(target ? 1 : 0);
