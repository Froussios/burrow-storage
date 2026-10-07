// Rules tests for burrow/firestore.rules. Run: cd tests && npm install && npm test
// Covers FS-13: create at rev 0, chained update, wrong tok, skipped rev, extra field,
// oversize ct, list attempt (incl. `in` query on ids), delete attempt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, documentId,
} from "firebase/firestore";

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const newId = () => b64url(randomBytes(32)); // 43 chars

// emulators:exec exports FIRESTORE_EMULATOR_HOST; fall back to firebase.json's 127.0.0.1:8080.
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "burrow-rules-test",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host, port: Number(port) },
  });
});
after(async () => { await env.cleanup(); });

const db = () => env.unauthenticatedContext().firestore();

function envelope(rev, tok, nextTok, extra = {}) {
  return {
    v: 1, iv: b64url(randomBytes(12)), ct: "AAAA", rev, ts: Date.now(),
    tok, next: sha256hex(nextTok), ...extra,
  };
}

test("create at rev 0 succeeds and is readable without auth", async () => {
  const id = newId();
  await assertSucceeds(setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1")));
  const snap = await assertSucceeds(getDoc(doc(db(), "burrow", id)));
  assert.equal(snap.data().rev, 0);
});

test("create at rev != 0 is rejected", async () => {
  await assertFails(setDoc(doc(db(), "burrow", newId()), envelope(3, "t3", "t4")));
});

test("chained update with the committed token succeeds (verifies hashing.sha256 behaviour)", async () => {
  const id = newId();
  await setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1"));
  await assertSucceeds(setDoc(doc(db(), "burrow", id), envelope(1, "t1", "t2")));
});

test("update with the wrong token is rejected", async () => {
  const id = newId();
  await setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1"));
  await assertFails(setDoc(doc(db(), "burrow", id), envelope(1, "not-t1", "t2")));
});

test("update that skips a revision is rejected", async () => {
  const id = newId();
  await setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1"));
  await assertFails(setDoc(doc(db(), "burrow", id), envelope(2, "t1", "t2")));
});

test("replaying an older revision is rejected", async () => {
  const id = newId();
  await setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1"));
  await setDoc(doc(db(), "burrow", id), envelope(1, "t1", "t2"));
  await assertFails(setDoc(doc(db(), "burrow", id), envelope(1, "t1", "t2")));
});

test("extra field is rejected", async () => {
  await assertFails(setDoc(doc(db(), "burrow", newId()), envelope(0, "t0", "t1", { owner: "me" })));
});

test("oversize ct is rejected", async () => {
  await assertFails(setDoc(doc(db(), "burrow", newId()), { ...envelope(0, "t0", "t1"), ct: "A".repeat(1000001) }));
});

test("FS-2 an iv that is not 16 characters is rejected", async () => {
  for (const iv of [b64url(randomBytes(8)), b64url(randomBytes(16)), ""]) {
    await assertFails(setDoc(doc(db(), "burrow", newId()), { ...envelope(0, "t0", "t1"), iv }));
  }
});

test("id that is not 43 chars is rejected", async () => {
  await assertFails(setDoc(doc(db(), "burrow", "short"), envelope(0, "t0", "t1")));
});

test("list is denied, including an `in` query on document ids", async () => {
  const id = newId();
  await setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1"));
  await assertFails(getDocs(collection(db(), "burrow")));
  await assertFails(getDocs(query(collection(db(), "burrow"), where(documentId(), "in", [id]))));
});

test("delete is denied", async () => {
  const id = newId();
  await setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1"));
  await assertFails(deleteDoc(doc(db(), "burrow", id)));
});

test("partial update cannot bypass the chain", async () => {
  const id = newId();
  await setDoc(doc(db(), "burrow", id), envelope(0, "t0", "t1"));
  await assertFails(updateDoc(doc(db(), "burrow", id), { ct: "BBBB" }));
});
