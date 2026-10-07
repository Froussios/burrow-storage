#!/usr/bin/env node
// FS-10: `npx burrow-setup firestore` prints the exact steps to create the shared Burrow store on
// Firebase's Spark plan. `--run` performs them with scripts/setup.sh (needs gcloud and a browser login).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const [target, ...flags] = process.argv.slice(2);
const project = process.env.PROJECT ?? "<your-project-id>";

if (target !== "firestore") {
  console.log("usage: npx burrow-setup firestore [--run]\n\nEnv: PROJECT, LOCATION, REFERRERS (see below).");
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
      "Browser key (auto created by Firebase)" ->
        API restrictions: Cloud Firestore API only
        Application restrictions: Websites -> your domains, e.g. https://you.github.io/*, http://localhost:*

 6. Leave Auth, Storage, Functions and Blaze off. Burrow needs none of them.

Spark ceilings (shared by all your prototypes): 1 GiB stored; 50,000 reads, 20,000 writes,
20,000 deletes per day. A sync with nothing new costs 1 read. Pushing n changed items costs n+1
writes and at least n+2 reads, because writes go through transactions. Hitting a ceiling pauses
sync until the daily reset. Full cost table: docs/firestore-setup.md.

Automate steps 1-5 with: npx burrow-setup firestore --run   (needs gcloud; opens a browser to sign in)
`);

if (flags.includes("--run")) {
  if (!process.env.PROJECT || !process.env.LOCATION) {
    console.error("--run needs PROJECT (your new project id) and LOCATION (e.g. us-central1) in the environment.");
    process.exit(1);
  }
  const r = spawnSync("bash", [join(pkg, "scripts", "setup.sh")], { cwd: join(pkg, "firebase"), stdio: "inherit", env: { ...process.env, PROJECT: project } });
  process.exit(r.status ?? 1);
}
