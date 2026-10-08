// Gate 2 (M5): a one-off check of your own LIVE project, named in the
// BURROW_FIRESTORE environment variable (apiKey/projectId; appId optional).
// Checks fresh unauthenticated creates and reads by id, refusal of forged
// write tokens and listing, backend conformance, and two-device sync.
// Does not check Spark vs Blaze, or whether
// Auth, Storage and Functions are off. Writes a few KB at ids derived from
// throwaway secrets; documents cannot be deleted (FS-6). Never runs in CI.
// See docs/firestore-setup.md, step 7, before running `npm run test:live`.
import { initializeApp, deleteApp } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  where,
  documentId,
} from "firebase/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { b64url, randomBytes, utf8 } from "../../src/bytes.js";
import {
  FirestoreBackend,
  type FirestoreConfig,
} from "../../src/backends/firestore.js";
import { deriveAppKeys } from "../../src/codec/derive.js";
import { seal } from "../../src/codec/envelope.js";
import { World } from "../support/devices.js";
import { backendConformance } from "./suite.js";

const guidance =
  "Set the BURROW_FIRESTORE environment variable to your project's valid config JSON (non-empty apiKey/projectId; appId/collection optional non-empty strings; omit emulator) before running npm run test:live. See docs/firestore-setup.md, step 7.";
const target = process.env.BURROW_FIRESTORE;
if (!target) throw new Error(guidance);
let config: FirestoreConfig;
try {
  config = JSON.parse(target);
} catch {
  throw new Error(guidance);
}
if (
  !config ||
  typeof config !== "object" ||
  Array.isArray(config) ||
  [config.apiKey, config.projectId].some(
    (v) => typeof v !== "string" || !v.trim(),
  ) ||
  (config.appId !== undefined &&
    (typeof config.appId !== "string" || !config.appId.trim())) ||
  (config.collection !== undefined &&
    (typeof config.collection !== "string" || !config.collection.trim())) ||
  config.emulator !== undefined
)
  throw new Error(guidance);
const collectionName = config.collection ?? "burrow";
const opened: FirestoreBackend[] = [];
const make = () => {
  const b = new FirestoreBackend(config);
  opened.push(b);
  return b;
};
const raw = initializeApp(config, "gate2-raw");
const db = getFirestore(raw);
afterAll(async () => {
  await Promise.all(opened.map((b) => b.close()));
  await deleteApp(raw);
});

describe("Gate 2: live checks", () => {
  let knownId = "";

  it("a first write at a fresh id succeeds, and get of that known id succeeds unauthenticated", async () => {
    const keys = await deriveAppKeys(randomBytes(32), "gate2");
    knownId = keys.base;
    const env = await seal(
      { key: keys.encKey, mac: keys.macKey, aad: knownId + "gate2" },
      knownId,
      0,
      utf8('{"v":1,"items":{}}'),
      Date.now(),
    );
    await make().put(knownId, env, null);
    const snap = await getDoc(doc(db, collectionName, knownId));
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual(env);
  });

  it("an update with a wrong tok is rejected by the rules", async () => {
    const env = (await getDoc(doc(db, collectionName, knownId))).data()!;
    const forged = { ...env, rev: env.rev + 1, tok: b64url(randomBytes(32)) };
    await expect(
      setDoc(doc(db, collectionName, knownId), forged),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("list is rejected, including an `in` query on ids", async () => {
    await expect(getDocs(collection(db, collectionName))).rejects.toMatchObject(
      {
        code: "permission-denied",
      },
    );
    await expect(
      getDocs(
        query(
          collection(db, collectionName),
          where(documentId(), "in", [knownId]),
        ),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

backendConformance(`FirestoreBackend (LIVE ${config.projectId})`, make);

describe("Burrow over the live store", () => {
  it("two devices sync with no account", async () => {
    const world = new World();
    try {
      const a = await world.device().open({ app: "gate2", backend: make() });
      const b = await world.device().open({ app: "gate2", backend: make() });
      await a.set({ theme: "dark", draft: "hello from gate 2" });
      await a.syncNow();
      const statuses: string[] = [];
      b.onStatus.addListener((s) =>
        statuses.push(
          `${s.status}${s.error ? `:${s.error.code}:${String((s.error.cause as Error)?.message ?? "")}` : ""}`,
        ),
      );
      await b.link({ token: await a.exportToken() });
      const data = await b.get();
      if (!Object.keys(data).length)
        throw new Error(
          "EMPTY statuses=" +
            JSON.stringify(statuses) +
            " b=" +
            JSON.stringify(b.inspect()) +
            " a=" +
            JSON.stringify(a.inspect()) +
            " aGet=" +
            JSON.stringify(await a.get()),
        );
      expect({ data, statuses }).toMatchObject({
        data: { theme: "dark", draft: "hello from gate 2" },
      });
    } finally {
      world.close();
    }
  });
});
