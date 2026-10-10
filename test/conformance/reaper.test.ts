// Real conditional server writes and adapter races; emulator only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirestoreBackend } from "../../src/backends/firestore.js";
import { b64url, randomBytes, utf8 } from "../../src/bytes.js";
import { deriveAppKeys } from "../../src/codec/derive.js";
import { seal } from "../../src/codec/envelope.js";
import {
  conditionalStub,
  expiryCandidate,
  parseArgs,
  reap,
  RETENTION_MS,
  type Request,
} from "../../scripts/burrow-reaper.mjs";
import type { StoredDocument } from "../../src/types.js";

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error("emulator required");
const project = "burrow-expiry-test";
const db = `projects/${project}/databases/(default)`;
const prefix = `${db}/documents/burrow`;
const [hostname, port] = host.split(":");
const backend = new FirestoreBackend({
  projectId: project,
  apiKey: "emulator",
  emulator: { host: hostname!, port: Number(port) },
});
const request: Request = (path, init = {}) =>
  fetch(`http://${host}/v1${path}`, {
    ...init,
    headers: {
      authorization: "Bearer owner",
      "content-type": "application/json",
    },
  });
beforeAll(async () => {
  const rules = await readFile(
    new URL("../../firebase/firestore.rules", import.meta.url),
    "utf8",
  );
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${project}:securityRules`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: { files: [{ name: "firestore.rules", content: rules }] },
      }),
    },
  );
  expect(response.ok).toBe(true);
});
afterAll(() => backend.close());
async function chain() {
  const keys = await deriveAppKeys(randomBytes(32), "expiry");
  const id = b64url(randomBytes(32));
  const cipher = { key: keys.encKey, mac: keys.macKey, aad: id + "expiry" };
  const envelope = (rev: number) =>
    seal(cipher, id, rev, utf8(`payload ${rev}`), Date.now());
  const e0 = await envelope(0);
  await backend.put(id, e0, null);
  const response = await request(`/${prefix}/${id}`);
  expect(response.ok).toBe(true);
  const doc = await response.json();
  const candidate = expiryCandidate(
    doc,
    prefix,
    Date.parse(doc.updateTime) + RETENTION_MS + 1000,
  );
  if (typeof candidate === "string")
    throw new Error("expected eligible server document");
  return { id, e0, doc, candidate, envelope };
}

describe("D-48 conditional cleanup against Firestore emulator", () => {
  it("a concurrent authenticated write defeats an old exact updateTime precondition", async () => {
    const c = await chain();
    const e1 = await c.envelope(1);
    await backend.put(c.id, e1, 0);
    expect(await conditionalStub(request, db, c.candidate)).toBe(false);
    expect(await backend.get(c.id)).toEqual(e1);
  });

  it("minimal whole-document stubbing is readable/watched at the same revision; atomic put refuses it until explicit opt-in", async () => {
    const c = await chain();
    const seen: StoredDocument[] = [];
    const stop = backend.subscribe(c.id, (env) => seen.push(env));
    try {
      await expect.poll(() => seen).toContainEqual(c.e0);
      expect(await conditionalStub(request, db, c.candidate)).toBe(true);
      const stub = { x: true, rev: c.e0.rev, next: c.e0.next };
      expect(await backend.get(c.id)).toEqual(stub);
      await expect.poll(() => seen, { timeout: 10_000 }).toContainEqual(stub);
      const raw = await (await request(`/${prefix}/${c.id}`)).json();
      expect(Object.keys(raw.fields).sort()).toEqual(["next", "rev", "x"]);
      const e1 = await c.envelope(1);
      await expect(backend.put(c.id, e1, 0)).rejects.toMatchObject({
        code: "expired",
      });
      await backend.put(c.id, e1, 0, { replaceExpired: true });
      expect(await backend.get(c.id)).toEqual(e1);
    } finally {
      stop();
    }
  });

  it("racing a transaction and conditional stub has only safe outcomes", async () => {
    for (let i = 0; i < 3; i++) {
      const c = await chain();
      const e1 = await c.envelope(1);
      const [put, stub] = await Promise.allSettled([
        backend.put(c.id, e1, 0),
        conditionalStub(request, db, c.candidate),
      ]);
      expect(stub.status).toBe("fulfilled");
      if (put.status === "fulfilled") {
        expect(stub).toMatchObject({ value: false });
        expect(await backend.get(c.id)).toEqual(e1);
      } else {
        expect(put.reason).toMatchObject({ code: "expired" });
        expect(stub).toMatchObject({ value: true });
        expect(await backend.get(c.id)).toEqual({
          x: true,
          rev: c.e0.rev,
          next: c.e0.next,
        });
      }
    }
  });

  it("the paginated owner utility dry-runs before applying actual timestamp-conditioned minimal stubs", async () => {
    const c = await chain();
    const dir = await mkdtemp(join(tmpdir(), "burrow-reaper-emulator-"));
    try {
      const options = {
        ...parseArgs([
          "--project",
          project,
          "--database",
          "(default)",
          "--collection",
          "burrow",
          "--content-only",
          "--page-size",
          "2",
        ]),
        state: join(dir, "cache.json"),
      };
      const now = () => Date.now() + RETENTION_MS + 10_000;
      const dry = await reap(options, { request, now });
      expect(dry.eligible).toBeGreaterThan(0);
      expect(dry.stubbed).toBe(0);
      expect(await backend.get(c.id)).toEqual(c.e0);
      const applied = await reap({ ...options, apply: true }, { request, now });
      expect(applied.stubbed).toBe(dry.eligible);
      expect(applied.refused).toBe(0);
      expect(await backend.get(c.id)).toEqual({
        x: true,
        rev: c.e0.rev,
        next: c.e0.next,
      });
      const again = await reap({ ...options, apply: true }, { request, now });
      expect(again.stubbed).toBe(0);
      expect(again.stubs).toBe(applied.scanned);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
