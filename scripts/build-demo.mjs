#!/usr/bin/env node
// Assembles the deployable demo in site/ (#24): the demo page, script and style, with the two
// bundles from dist/ beside them, so the page's `script-src 'self'` covers them. The page's build
// footer is stamped with the commit and the build time, so testers know which head they are on.
// Run after `npm run build`. Uses GITHUB_SHA and GITHUB_REPOSITORY when set (GitHub Actions),
// otherwise git and package.json.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site");
const FILES = [["demo", "demo.js"], ["demo", "demo.css"], ["demo", "favicon.svg"], ["dist", "burrow.min.js"], ["dist", "burrow-firestore.js"]];
const OPTIONAL = [["dist", "burrow.min.js.map"]];
const FOOTER = /<footer id="build"[^>]*>[\s\S]*?<\/footer>/;

const fail = (msg) => { console.error(`build-demo: ${msg}`); process.exit(1); };

for (const [dir, f] of FILES) if (!existsSync(join(root, dir, f))) fail(`${dir}/${f} is missing${dir === "dist" ? "; run npm run build first" : ""}`);

// On pull_request runs GITHUB_SHA is the test merge commit, which only exists in that run, so the
// footer link 404s there; deploys run on push to main, where it is the pushed commit.
const commit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`not a commit id: ${commit}`);
const repo = process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}`
  : JSON.parse(readFileSync(join(root, "package.json"), "utf8")).repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
if (!/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(repo)) fail(`not a repository URL: ${repo}`);
const built = new Date().toISOString().replace(/\.\d+Z$/, "Z");

const html = readFileSync(join(root, "demo", "index.html"), "utf8");
if (!FOOTER.test(html)) fail('demo/index.html has no <footer id="build">');
const footer = `<footer id="build" class="build" data-commit="${commit}" data-built="${built}">` +
  `Build <a href="${repo}/commit/${commit}">${commit.slice(0, 7)}</a>, ` +
  `<time datetime="${built}">${built.slice(0, 16).replace("T", " ")} UTC</time></footer>`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
writeFileSync(join(out, "index.html"), html.replace(FOOTER, () => footer));
for (const [dir, f] of [...FILES, ...OPTIONAL.filter(([d, f]) => existsSync(join(root, d, f)))]) copyFileSync(join(root, dir, f), join(out, f));
console.log(`site/ assembled: build ${commit.slice(0, 7)} at ${built}`);
