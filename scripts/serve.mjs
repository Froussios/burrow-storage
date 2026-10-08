#!/usr/bin/env node
// Static file server for the demo and the browser tests. Serves the repo root;
// files missing from demo/ fall back to dist/ (burrow.min.js,
// burrow-firestore.js), as a deployed demo has them; site/ is the assembled
// demo (scripts/build-demo.mjs). Local pages in demo/ and site/ use the
// emulator by default, or an explicit project from BURROW_FIRESTORE (#40).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT ?? 4173);
const LIVE = "https://firestore.googleapis.com";
const guidance =
  "BURROW_FIRESTORE must be config JSON with non-empty apiKey and projectId strings; appId and collection are optional non-empty strings. Omit emulator. See docs/firestore-setup.md#local-development.";

function localTarget() {
  const supplied = process.env.BURROW_FIRESTORE;
  if (supplied !== undefined) {
    let cfg;
    try {
      cfg = JSON.parse(supplied);
    } catch {
      throw new Error(guidance);
    }
    if (
      !cfg ||
      Array.isArray(cfg) ||
      ["apiKey", "projectId"].some(
        (key) => typeof cfg[key] !== "string" || !cfg[key].trim(),
      ) ||
      (cfg.appId !== undefined &&
        (typeof cfg.appId !== "string" || !cfg.appId.trim())) ||
      (cfg.collection !== undefined &&
        (typeof cfg.collection !== "string" || !cfg.collection.trim())) ||
      cfg.emulator !== undefined
    )
      throw new Error(guidance);
    if (process.env.FIRESTORE_EMULATOR_HOST)
      throw new Error(
        "Choose BURROW_FIRESTORE or FIRESTORE_EMULATOR_HOST, not both. See docs/firestore-setup.md#local-development.",
      );
    const { apiKey, projectId, appId, collection } = cfg;
    return {
      config: {
        apiKey,
        projectId,
        ...(appId !== undefined ? { appId } : {}),
        ...(collection ? { collection } : {}),
      },
      endpoint: LIVE,
      label: `project ${JSON.stringify(projectId)}`,
    };
  }
  const emu = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [host, p] = emu.split(":");
  return {
    config: {
      apiKey: "emulator",
      projectId: "burrow-rules-test",
      appId: "1:0:web:0",
      emulator: { host, port: Number(p) },
    },
    endpoint: `http://${emu}`,
    label: `emulator ${emu}`,
  };
}

let target;
try {
  target = localTarget();
} catch (e) {
  console.error(`serve.mjs: ${e.message}`);
  process.exit(1);
}
// Config is inserted into a single-quoted HTML attribute. Use a replacement
// callback below so config values containing '$' stay literal too.
const pageConfig = JSON.stringify(target.config)
  .replaceAll("&", "&amp;")
  .replaceAll("'", "&#39;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
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

function forLocalTarget(html) {
  // Attributes may sit on separate lines (Prettier wraps the tag).
  const meta = /(<meta\s+name="burrow-firestore"\s+content=')[^']*'/;
  // A page must get the selected config, or it could sync with the owner's
  // project instead (#39, #40).
  if (html.includes("burrow-firestore") && !meta.test(html))
    throw new Error("burrow-firestore config not found");
  return html
    .replace(meta, (_, prefix) => `${prefix}${pageConfig}'`)
    .replace(
      /connect-src ([^;"]*)/,
      (_, sources) =>
        `connect-src ${sources.replace(/\s*https:\/\/firestore\.googleapis\.com/g, "").trim()} ${target.endpoint}`,
    );
}

const server = createServer(async (req, res) => {
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
    [join(root, "demo"), join(root, "site")].some((d) =>
      path.startsWith(d + sep),
    ) &&
    path.endsWith(".html")
  ) {
    try {
      body = Buffer.from(forLocalTarget(body.toString()));
    } catch (e) {
      console.error(
        `serve.mjs: cannot configure ${rel} for the selected backend: ${e.message}`,
      );
      res
        .writeHead(500, { "content-type": "text/plain" })
        .end(`cannot configure ${rel} for the selected backend: ${e.message}`);
      return;
    }
  }
  res
    .writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    .end(body);
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(
    `serving ${root} on http://localhost:${address.port} (${target.label})`,
  );
});
