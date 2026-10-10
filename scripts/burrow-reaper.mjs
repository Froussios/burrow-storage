#!/usr/bin/env node
// Optional owner maintenance; never invoked by the browser, CI or setup.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const RETENTION_MS = 395 * 86_400_000;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const fail = (code) => {
  throw new ReaperError(code);
};
export class ReaperError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReaperError";
    this.code = code;
  }
}

export function parseArgs(args) {
  const options = {
    apply: false,
    contentOnly: false,
    pageSize: 100,
    maxReads: 10_000,
    maxWrites: 1_000,
    state: ".burrow-reaper-cache.json",
  };
  const names = {
    "--project": "project",
    "--database": "database",
    "--collection": "collection",
    "--state": "state",
    "--page-size": "pageSize",
    "--max-reads": "maxReads",
    "--max-writes": "maxWrites",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--content-only") options.contentOnly = true;
    else if (arg === "--mixed") fail("mixed-collection-refused");
    else if (names[arg] && args[i + 1] && !args[i + 1].startsWith("--")) {
      const key = names[arg];
      options[key] = ["pageSize", "maxReads", "maxWrites"].includes(key)
        ? Number(args[++i])
        : args[++i];
    } else fail("invalid-arguments");
  }
  validate(options);
  return options;
}

function validate(o) {
  if (!o.contentOnly) fail("content-only-acknowledgment-required");
  if (
    !/^[a-z][a-z0-9-]{4,62}$/.test(o.project ?? "") ||
    !/^(\(default\)|[a-z][a-z0-9-]{3,62})$/.test(o.database ?? "") ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(o.collection ?? "")
  )
    fail("explicit-target-required");
  if (
    !o.state ||
    !Number.isInteger(o.pageSize) ||
    o.pageSize < 1 ||
    o.pageSize > 100 ||
    !Number.isInteger(o.maxReads) ||
    o.maxReads < 1 ||
    o.maxReads > 50_000 ||
    !Number.isInteger(o.maxWrites) ||
    o.maxWrites < 0 ||
    o.maxWrites > 20_000
  )
    fail("invalid-budget");
}

// Firestore free quota resets at midnight Pacific time, including DST.
export const quotaDay = (now) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

/** Eligible server timestamps are output-only; envelope ts is never read. */
export function expiryCandidate(doc, prefix, now) {
  if (doc.fields?.x?.booleanValue === true) return "stub";
  const time = doc.updateTime;
  if (
    typeof time !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(time)
  )
    return "refused";
  const ms = Date.parse(time);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== time.slice(0, 19)
  )
    return "refused";
  if (now - ms < RETENTION_MS) return "active";
  const id =
    typeof doc.name === "string" && doc.name.startsWith(prefix + "/")
      ? doc.name.slice(prefix.length + 1)
      : "";
  const rawRev = doc.fields?.rev?.integerValue;
  const rev =
    typeof rawRev === "string" && /^\d+$/.test(rawRev) ? Number(rawRev) : NaN;
  const next = doc.fields?.next?.stringValue;
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(id) ||
    !Number.isSafeInteger(rev) ||
    rev < 0 ||
    typeof next !== "string" ||
    next.length !== 64
  )
    return "refused";
  return {
    update: {
      name: doc.name,
      fields: {
        x: { booleanValue: true },
        rev: { integerValue: String(rev) },
        next: { stringValue: next },
      },
    },
    currentDocument: { updateTime: time },
  };
}

/**
 * Replace the entire document, conditioned on the exact observed server time.
 */
export async function conditionalStub(request, databasePath, write) {
  if (
    typeof write.currentDocument?.updateTime !== "string" ||
    !write.currentDocument.updateTime
  )
    fail("server-update-time-required");
  const result = await request(`/${databasePath}/documents:commit`, {
    method: "POST",
    body: JSON.stringify({ writes: [write] }),
  });
  if (!result.ok) {
    let status;
    try {
      status = (await result.json()).error?.status;
    } catch {
      /* Fixed error below. */
    }
    if (status === "FAILED_PRECONDITION" || status === "NOT_FOUND")
      return false;
    fail("request-failed");
  }
  return true;
}

/**
 * Private operator cache stores aggregate quota reservations and opaque scan
 * cursors. Use the same file for every invocation/target in this project.
 */
async function ledger(path) {
  let lock;
  try {
    lock = await open(path + ".lock", "wx", 0o600);
  } catch {
    fail("budget-cache-locked-or-unavailable");
  }
  try {
    let data;
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") fail("invalid-budget-cache");
      data = { version: 1, projects: {}, scans: {} };
    }
    if (
      data.version !== 1 ||
      !data.projects ||
      !data.scans ||
      Array.isArray(data.projects) ||
      Array.isArray(data.scans)
    )
      fail("invalid-budget-cache");
    const save = async () => {
      const temp = path + ".tmp";
      const file = await open(temp, "w", 0o600);
      try {
        await file.chmod(0o600);
        await file.writeFile(JSON.stringify(data));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
    };
    return {
      data,
      save,
      close: async () => {
        await lock.close();
        await unlink(path + ".lock");
      },
    };
  } catch (e) {
    await lock.close();
    await unlink(path + ".lock");
    throw e;
  }
}

export async function reap(options, { request, now = Date.now } = {}) {
  validate(options);
  if (typeof request !== "function") fail("transport-required");
  const cache = await ledger(options.state);
  const summary = {
    scanned: 0,
    eligible: 0,
    stubbed: 0,
    changed: 0,
    active: 0,
    stubs: 0,
    refused: 0,
    budgetStopped: false,
  };
  const databasePath = `projects/${options.project}/databases/${options.database}`;
  const prefix = `${databasePath}/documents/${options.collection}`;
  const projectKey = hash(options.project);
  const scanKey = hash(prefix + (options.apply ? ":apply" : ":dry"));
  try {
    const reserve = async (reads, writes) => {
      const day = quotaDay(now());
      let budget = cache.data.projects[projectKey];
      if (!budget || budget.day !== day)
        budget = cache.data.projects[projectKey] = { day, reads: 0, writes: 0 };
      if (
        !Number.isSafeInteger(budget.reads) ||
        budget.reads < 0 ||
        !Number.isSafeInteger(budget.writes) ||
        budget.writes < 0
      )
        fail("invalid-budget-cache");
      if (
        budget.reads + reads > options.maxReads ||
        budget.writes + writes > options.maxWrites
      )
        return false;
      budget.reads += reads;
      budget.writes += writes;
      // Reserve before requests, including failures/crashes.
      await cache.save();
      return true;
    };
    let cursor = cache.data.scans[scanKey] ?? "";
    if (typeof cursor !== "string") fail("invalid-budget-cache");
    for (;;) {
      const day = quotaDay(now());
      const budget = cache.data.projects[projectKey];
      const used = budget?.day === day ? budget.reads : 0;
      const size = Math.min(options.pageSize, options.maxReads - used);
      if (size < 1 || !(await reserve(size, 0))) {
        summary.budgetStopped = true;
        break;
      }
      const query = new URLSearchParams({ pageSize: String(size) });
      for (const field of ["x", "rev", "next"])
        query.append("mask.fieldPaths", field);
      if (cursor) query.set("pageToken", cursor);
      const response = await request(`/${prefix}?${query}`);
      if (!response.ok) fail("request-failed");
      let page;
      try {
        page = await response.json();
      } catch {
        fail("request-failed");
      }
      if (page.documents !== undefined && !Array.isArray(page.documents))
        fail("request-failed");
      const documents = page.documents ?? [];
      if (
        documents.length > size ||
        (page.nextPageToken !== undefined &&
          typeof page.nextPageToken !== "string")
      )
        fail("request-failed");
      let completed = true;
      for (const doc of documents) {
        summary.scanned++;
        const candidate = expiryCandidate(doc, prefix, now());
        if (typeof candidate === "string") {
          summary[candidate === "stub" ? "stubs" : candidate]++;
          continue;
        }
        summary.eligible++;
        if (!options.apply) continue;
        if (!(await reserve(0, 1))) {
          summary.budgetStopped = true;
          completed = false;
          break;
        }
        if (await conditionalStub(request, databasePath, candidate))
          summary.stubbed++;
        else summary.changed++;
      }
      // Keep the current page cursor when the write budget interrupts it.
      if (!completed) break;
      cursor = page.nextPageToken ?? "";
      cache.data.scans[scanKey] = cursor;
      await cache.save();
      if (!cursor) break;
    }
    return summary;
  } finally {
    await cache.close();
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "burrow-reaper --project ID --database ID --collection NAME --content-only [--apply] [--state PATH] [--max-reads N] [--max-writes N] [--page-size N]\nDry-run by default. Content-only targets; never point at token-access or mixed stores. See docs/retention.md.",
    );
    return;
  }
  if (process.env.CI) fail("outside-ci-only");
  const options = parseArgs(process.argv.slice(2));
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (host && !/^(localhost|127\.0\.0\.1):\d{1,5}$/.test(host))
    fail("local-emulator-required");
  const token = host ? "owner" : process.env.BURROW_FIRESTORE_ADMIN_TOKEN;
  if (!token) fail("admin-token-required");
  const origin = host
    ? `http://${host}/v1`
    : "https://firestore.googleapis.com/v1";
  const request = (path, init = {}) =>
    fetch(origin + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  console.log(JSON.stringify(await reap(options, { request })));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main().catch((e) => {
    console.error(
      `FAIL ${e instanceof ReaperError ? e.code : "operation-failed"}`,
    );
    process.exitCode = 1;
  });
