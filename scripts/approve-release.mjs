#!/usr/bin/env node
// D-53: the owner's half of a release. release.yml stages the version on npm
// and drafts the GitHub release; this approves the staged version with 2FA
// and publishes the draft. Usage: npm run release:approve [-- <version>]
// (defaults to package.json's version). Needs an npm with `npm stage` and gh.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = process.argv[2] ?? pkg.version;
const tag = `v${version}`;

const staged = JSON.parse(
  execFileSync("npm", ["stage", "list", pkg.name, "--json"], {
    encoding: "utf8",
  }),
).filter((s) => s.status === "staged");
const stage = staged.find((s) => s.version === version);
if (!stage) {
  const others = staged.map((s) => s.version).join(", ") || "none";
  console.error(`${pkg.name}@${version} is not staged (staged: ${others}).`);
  process.exit(1);
}
// Only versions staged by release.yml through trusted publishing carry the
// workflow's provenance; anything else is not ours to approve.
if (stage.actorType !== "trusted automation") {
  console.error(
    `${pkg.name}@${version} was staged by ${stage.actor} (${stage.actorType}), not release.yml. Not approving.`,
  );
  process.exit(1);
}

console.log(`${pkg.name}@${version}  tag ${stage.tag}  stage ${stage.id}`);
console.log(
  `staged ${stage.createdAt} by ${stage.actor}, shasum ${stage.shasum}`,
);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const otp = (
  await rl.question("2FA code to approve (empty to cancel): ")
).trim();
rl.close();
if (!otp) process.exit(1);

execFileSync("npm", ["stage", "approve", stage.id, `--otp=${otp}`], {
  stdio: "inherit",
});
execFileSync("gh", ["release", "edit", tag, "--draft=false"], {
  stdio: "inherit",
});
console.log(`Published ${pkg.name}@${version} and the ${tag} GitHub release.`);
