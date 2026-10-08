#!/usr/bin/env node
// FS-10: print human console steps; the shipped agent guide handles setup.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const [target, ...args] = process.argv.slice(2);
const project = process.env.PROJECT ?? "<your-project-id>";

const usage =
  "usage: npx burrow-setup firestore\n       npx burrow-setup check '<config JSON>'";

if (target === "check") {
  let config;
  try {
    config = JSON.parse(args[0]);
    if (
      args.length !== 1 ||
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      ["apiKey", "projectId", "appId"].some(
        (field) => typeof config[field] !== "string" || !config[field].trim(),
      ) ||
      Object.keys(config).some(
        (field) => !["apiKey", "projectId", "appId"].includes(field),
      )
    )
      throw new Error();
  } catch {
    console.error(
      "Supply your own config JSON with apiKey, projectId and appId only.",
    );
    process.exit(1);
  }
  if (process.env.CI) {
    console.error("Live setup checks must not run in CI.");
    process.exit(1);
  }
  if (!globalThis.crypto?.subtle) {
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
      else console.error("FAIL setup-check: network");
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

if (target !== "firestore" || args.length) {
  console.log(usage);
  if (target === "firestore" && args.includes("--run"))
    console.error(
      "--run was removed. Follow firebase/SETUP-AGENT.md for agent-assisted setup.",
    );
  process.exit(target ? 1 : 0);
}

console.log(`Burrow shared store on Firebase (Spark plan: no card, hard daily quotas, never a bill)

One project serves every prototype. Do this once.

 1. Create the project (no billing account => Spark):
      https://console.firebase.google.com  ->  Add project  ->  "${project}"
      Turn Google Analytics off. Do not upgrade to Blaze.

 2. Create Firestore in *production mode*:
      Build -> Firestore Database -> Create database -> Production mode
      Pick a location close to your users. It cannot be changed later.

 3. Register a web app and copy its config (three fields are used):
      Project settings -> Your apps -> Web -> register "burrow"
      { apiKey, projectId, appId }  ->  put them in <meta name="burrow-firestore" content='{…}'>

 4. Deploy the Burrow rules (they ship in this package):
      cd ${join(pkg, "firebase")}
      npx firebase-tools login
      npx firebase-tools deploy --only firestore:rules --project ${project}

 5. Restrict the browser API key (it is an identifier, not a secret):
      https://console.cloud.google.com/apis/credentials?project=${project}
      Find the key matching apiKey from your web app config (do not select by display name) ->
        API restrictions: Cloud Firestore API only
        Application restrictions: Websites -> your domains, e.g. https://you.github.io/*, http://localhost:*

 6. Leave Auth, Storage, Functions, Hosting and Blaze off. Burrow needs none of them.

 7. Optionally check your own project (Node 20+, optional Firebase peer installed; never in CI):
      npx burrow-setup check '{"apiKey":"…","projectId":"${project}","appId":"…"}'
      Writes one throwaway document that cannot be deleted through client rules.
      Checks create/read by id, a forged write token, list and in queries.
      Does not check Spark billing or enabled products; browser key restrictions may block Node.
      Keep the browser key restricted. See firebase/SETUP-AGENT.md, step 9.
      Maintainers can also run BURROW_FIRESTORE='<config JSON>' npm run test:live from a clone.

Spark ceilings (shared by all your prototypes): 1 GiB stored; 50,000 reads, 20,000 writes,
20,000 deletes per day. A sync with nothing new costs 1 read. Pushing n changed items costs n+1
writes and at least n+2 reads, because writes go through transactions. Hitting a ceiling pauses
sync until the daily reset. Full cost table: docs/firestore-setup.md.

For agent-assisted setup, follow: ${join(pkg, "firebase", "SETUP-AGENT.md")}
`);
