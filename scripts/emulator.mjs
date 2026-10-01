#!/usr/bin/env node
// Runs a command under the Firestore emulator using firebase/firebase.json.
// BURROW_EMULATOR_PORT overrides the port (default 8080 from firebase.json) when it is taken locally.
// emulators:exec exports FIRESTORE_EMULATOR_HOST to the child, which the tests read.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "firebase");
const cmd = process.argv[2];
if (!cmd) { console.error("usage: emulator.mjs \"<command>\""); process.exit(2); }

let config = "firebase.json";
const port = process.env.BURROW_EMULATOR_PORT;
if (port) {
  const cfg = JSON.parse(readFileSync(join(dir, "firebase.json"), "utf8"));
  cfg.emulators.firestore.port = Number(port);
  config = ".firebase.emulator.json";
  writeFileSync(join(dir, config), JSON.stringify(cfg));
}
const bin = join(root, "node_modules", ".bin", "firebase");
const r = spawnSync(bin, ["emulators:exec", "--config", config, "--project", "burrow-rules-test", "--only", "firestore", `cd .. && ${cmd}`],
  { cwd: dir, stdio: "inherit" });
if (port) rmSync(join(dir, config), { force: true });
process.exit(r.status ?? 1);
