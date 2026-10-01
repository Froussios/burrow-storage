#!/usr/bin/env node
// SEC-6: Subresource Integrity hashes for the browser bundles; written to dist/sri.json and printed
// as ready-to-paste <script> tags for the release notes and README.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const files = ["burrow.min.js", "burrow-firestore.js"];
const sri = Object.fromEntries(files.map((f) => [f, "sha384-" + createHash("sha384").update(readFileSync(`dist/${f}`)).digest("base64")]));
writeFileSync("dist/sri.json", JSON.stringify(sri, null, 2) + "\n");
const cdn = `https://cdn.jsdelivr.net/npm/burrow-storage@${version}/dist`;
console.log(`<script src="${cdn}/burrow.min.js" integrity="${sri["burrow.min.js"]}" crossorigin="anonymous"></script>`);
console.log(`<!-- burrow-firestore.js (${sri["burrow-firestore.js"]}) loads on demand next to burrow.min.js. Self-host both files for a 'self'-only CSP. -->`);
