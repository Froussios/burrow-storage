#!/usr/bin/env node
// Static file server for the demo and the browser tests. Serves the repo root;
// files missing from demo/ fall back to dist/ (burrow.min.js,
// burrow-firestore.js), as a deployed demo has them; site/ is the assembled
// demo (scripts/build-demo.mjs). With FIRESTORE_EMULATOR_HOST set, the
// Firestore config and CSP of the pages in demo/ and site/ point at the
// emulator.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT ?? 4173);
const emu = process.env.FIRESTORE_EMULATOR_HOST;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function file(p) {
  try {
    const s = await stat(p);
    return s.isFile()
      ? p
      : s.isDirectory()
        ? file(join(p, "index.html"))
        : null;
  } catch {
    return null;
  }
}

function forEmulator(html) {
  const [host, p] = emu.split(":");
  const cfg = JSON.stringify({
    apiKey: "emulator",
    projectId: "burrow-rules-test",
    appId: "1:0:web:0",
    emulator: { host, port: Number(p) },
  });
  return html
    .replace(/(<meta name="burrow-firestore"\s+content=')[^']*'/, `$1${cfg}'`)
    .replace(/connect-src ([^;"]*)/, `connect-src $1 http://${emu}`);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(
    /^([/\\])+/,
    "",
  );
  if (rel.startsWith("..")) {
    res.writeHead(400).end();
    return;
  }
  let path = await file(join(root, rel));
  if (!path && rel.startsWith("demo/"))
    path = await file(join(root, "dist", rel.slice(5)));
  if (!path) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  let body = await readFile(path);
  if (
    emu &&
    [join(root, "demo"), join(root, "site")].some((d) =>
      path.startsWith(d + sep),
    ) &&
    path.endsWith(".html")
  )
    body = Buffer.from(forEmulator(body.toString()));
  res
    .writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    .end(body);
}).listen(port, "127.0.0.1", () =>
  console.log(
    `serving ${root} on http://localhost:${port}${emu ? ` (emulator ${emu})` : ""}`,
  ),
);
