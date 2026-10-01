// Gate 2 (M5): the conformance suite and the brief's three checks against the LIVE shared
// project. Writes go to ids derived from throwaway secrets; documents cannot be deleted (FS-6).
// Run deliberately: `npm run test:live`.
import { initializeApp, deleteApp } from "firebase/app";
import { collection, doc, getDoc, getDocs, getFirestore, query, setDoc, where, documentId } from "firebase/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { b64url, randomBytes, utf8 } from "../../src/bytes.js";
import { FirestoreBackend } from "../../src/backends/firestore.js";
import { deriveAppKeys } from "../../src/codec/derive.js";
import { seal } from "../../src/codec/envelope.js";
import { World } from "../support/devices.js";
import { backendConformance } from "./suite.js";

const config = { apiKey: "AIzaSyAlBIGo0tVj_68_3JukpW-sQPNhJHhPJJk", projectId: "burrow-storage-shared", appId: "1:126236223407:web:6a19c0b9ddf3d9bbd3f15a" };
const opened: FirestoreBackend[] = [];
const make = () => { const b = new FirestoreBackend(config); opened.push(b); return b; };
const raw = initializeApp(config, "gate2-raw");
const db = getFirestore(raw);
afterAll(async () => { await Promise.all(opened.map((b) => b.close())); await deleteApp(raw); });

describe("Gate 2: live checks", () => {
  let knownId = "";

  it("a first write at a fresh id succeeds, and get of that known id succeeds unauthenticated", async () => {
    const keys = await deriveAppKeys(randomBytes(32), "gate2");
    knownId = keys.base;
    const env = await seal({ key: keys.encKey, mac: keys.macKey, aad: knownId + "gate2" }, knownId, 0, utf8('{"v":1,"items":{}}'), Date.now());
    await make().put(knownId, env, null);
    const snap = await getDoc(doc(db, "burrow", knownId));
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual(env);
  });

  it("an update with a wrong tok is rejected by the rules", async () => {
    const env = (await getDoc(doc(db, "burrow", knownId))).data()!;
    const forged = { ...env, rev: env.rev + 1, tok: b64url(randomBytes(32)) };
    await expect(setDoc(doc(db, "burrow", knownId), forged)).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("list is rejected, including an `in` query on ids", async () => {
    await expect(getDocs(collection(db, "burrow"))).rejects.toMatchObject({ code: "permission-denied" });
    await expect(getDocs(query(collection(db, "burrow"), where(documentId(), "in", [knownId])))).rejects.toMatchObject({ code: "permission-denied" });
  });
});

backendConformance("FirestoreBackend (LIVE burrow-storage-shared)", make);

describe("Burrow over the live store", () => {
  it("two devices sync with no account", async () => {
    const world = new World();
    try {
      const a = await world.device().open({ app: "gate2", backend: make() });
      const b = await world.device().open({ app: "gate2", backend: make() });
      await a.set({ theme: "dark", draft: "hello from gate 2" });
      await a.syncNow();
      const statuses: string[] = [];
      b.onStatus.addListener((s) => statuses.push(`${s.status}${s.error ? `:${s.error.code}:${String((s.error.cause as Error)?.message ?? "")}` : ""}`));
      await b.link({ code: await a.exportCode() });
      const data = await b.get();
      if (!Object.keys(data).length) throw new Error("EMPTY statuses=" + JSON.stringify(statuses) + " b=" + JSON.stringify(b.inspect()) + " a=" + JSON.stringify(a.inspect()) + " aGet=" + JSON.stringify(await a.get()));
      expect({ data, statuses }).toMatchObject({ data: { theme: "dark", draft: "hello from gate 2" } });
    } finally {
      world.close();
    }
  });
});
