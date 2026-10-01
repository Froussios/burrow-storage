// Runs under `firebase emulators:exec` (npm run emulator). Rules come from spike.rules via firebase.json.
// Requests carry no Authorization header, so the emulator evaluates rules with request.auth == null,
// exactly like an unauthenticated browser request against production.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { runRestMatrix, runRulesProbes } from "./rest-matrix.mjs";

const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const project = process.env.GCLOUD_PROJECT ?? "demo-burrow-spike";
const docsUrl = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
// The emulator ignores API keys; send one anyway so the request shape matches the adapter's.
const headers = { "x-goog-api-key": "emulator-ignores-this" };

const rules = await runRulesProbes({ docsUrl, headers });
const matrix = await runRestMatrix({ docsUrl, headers, raceWriters: 10 });

const pkg = (name) =>
  readFile(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8").then(
    (t) => JSON.parse(t).version,
  );
const emulatorJar = await readdir(`${homedir()}/.cache/firebase/emulators`)
  .then((files) => files.find((f) => f.startsWith("cloud-firestore-emulator")) ?? "unknown")
  .catch(() => "unknown");
const result = {
  target: "firestore-emulator",
  firebaseTools: await pkg("firebase-tools"),
  emulator: emulatorJar,
  node: process.version,
  ranAt: new Date().toISOString().slice(0, 10),
  rules,
  matrix,
};
await writeFile(new URL("./results/emulator.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");

console.table(rules.hashing);
console.log("request.auth == null:", rules.authIsNull);
console.table(matrix.map(({ name, http, status, ok }) => ({ name, http, status, ok })));
const failed = matrix.filter((s) => !s.ok);
if (failed.length) {
  console.error(
    `${failed.length} step(s) differ from the architecture's assumptions:`,
    failed.map((s) => s.name),
  );
  process.exitCode = 1;
}
