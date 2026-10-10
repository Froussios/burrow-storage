// The same conformance suite, against FirestoreBackend talking to the Firestore
// emulator with firebase/firestore.rules loaded (run via
// `npm run test:firestore`).
import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FirestoreBackend } from "../../src/backends/firestore.js";
import { b64url, randomBytes, utf8 } from "../../src/bytes.js";
import { deriveAppKeys } from "../../src/codec/derive.js";
import { seal } from "../../src/codec/envelope.js";
import { checkFirestore } from "../../src/setup/check.js";
import type { StoredDocument } from "../../src/types.js";
import { World } from "../support/devices.js";
import { backendConformance } from "./suite.js";

const hostEnv = process.env.FIRESTORE_EMULATOR_HOST;
if (!hostEnv) throw new Error("run under the emulator: npm run test:firestore");
const [host, port] = hostEnv.split(":");
const emulator = { host: host!, port: Number(port) };
const config = {
  apiKey: "emulator",
  projectId: "burrow-rules-test",
  // #23: Firestore does not require Firebase's web-app identifier.
  emulator,
};

const opened: FirestoreBackend[] = [];
const make = (projectId = config.projectId) => {
  const b = new FirestoreBackend({ ...config, projectId });
  opened.push(b);
  return b;
};
afterAll(async () => {
  await Promise.all(opened.map((b) => b.close()));
});

async function expire(b: FirestoreBackend, id: string) {
  const cur = (await b.get(id))!;
  const response = await fetch(
    `http://${hostEnv}/v1/projects/${config.projectId}/databases/(default)/documents/burrow/${id}`,
    {
      method: "PATCH",
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          x: { booleanValue: true },
          rev: { integerValue: String(cur.rev) },
          next: { stringValue: cur.next },
        },
      }),
    },
  );
  expect(response.ok).toBe(true);
}
backendConformance("FirestoreBackend (emulator)", make, (b, id) =>
  expire(b as FirestoreBackend, id),
);

describe("Burrow over FirestoreBackend (emulator)", () => {
  it("D-50 separate configured projects keep identical document ids and watches isolated", async () => {
    const projectId = "burrow-isolation-test";
    const rules = await readFile(
      new URL("../../firebase/firestore.rules", import.meta.url),
      "utf8",
    );
    const response = await fetch(
      `http://${hostEnv}/emulator/v1/projects/${projectId}:securityRules`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rules: { files: [{ name: "firestore.rules", content: rules }] },
        }),
      },
    );
    expect(response.ok, await response.text()).toBe(true);

    const content = make();
    const token = make(projectId);
    const id = b64url(randomBytes(32));
    const keys = await deriveAppKeys(randomBytes(32), "isolation");
    const cipher = {
      key: keys.encKey,
      mac: keys.macKey,
      aad: id + "isolation",
    };
    const content0 = await seal(cipher, id, 0, utf8("content"), Date.now());
    const token0 = await seal(cipher, id, 0, utf8("token"), Date.now());
    await Promise.all([
      content.put(id, content0, null),
      token.put(id, token0, null),
    ]);
    expect(await content.get(id)).toEqual(content0);
    expect(await token.getMany([id])).toEqual([token0]);

    const contentChanges: StoredDocument[] = [];
    const tokenChanges: StoredDocument[] = [];
    const stopContent = content.subscribe(id, (env) =>
      contentChanges.push(env),
    );
    const stopToken = token.subscribe(id, (env) => tokenChanges.push(env));
    try {
      await expect
        .poll(() => contentChanges, { timeout: 10_000 })
        .toContainEqual(content0);
      await expect
        .poll(() => tokenChanges, { timeout: 10_000 })
        .toContainEqual(token0);
      const content1 = await seal(
        cipher,
        id,
        1,
        utf8("new content"),
        Date.now(),
      );
      await content.put(id, content1, 0);
      await expect
        .poll(() => contentChanges, { timeout: 10_000 })
        .toContainEqual(content1);
      expect(await content.getMany([id])).toEqual([content1]);
      expect(await token.get(id)).toEqual(token0);
      const token1 = await seal(cipher, id, 1, utf8("new token"), Date.now());
      await token.put(id, token1, 0);
      await expect
        .poll(() => tokenChanges, { timeout: 10_000 })
        .toContainEqual(token1);
      expect(
        tokenChanges.every(
          (env) =>
            !("x" in env) && (env.ct === token0.ct || env.ct === token1.ct),
        ),
      ).toBe(true);
      expect(
        contentChanges.every(
          (env) =>
            !("x" in env) && (env.ct === content0.ct || env.ct === content1.ct),
        ),
      ).toBe(true);
      expect(await content.get(id)).toEqual(content1);
    } finally {
      stopContent();
      stopToken();
    }
  });

  it("two devices sync through the emulator", async () => {
    const world = new World();
    try {
      const A = world.device(),
        B = world.device();
      const a = await A.open({ backend: make() });
      const b = await B.open({ backend: make() });
      await a.set({ theme: "dark", draft: "hello" });
      await a.syncNow();
      await b.link({ token: await a.exportToken() });
      expect(await b.get()).toEqual({ theme: "dark", draft: "hello" });
      await b.remove("draft");
      await b.syncNow();
      await a.syncNow();
      expect(await a.get()).toEqual({ theme: "dark" });
    } finally {
      world.close();
    }
  });

  it("FS-9 onSnapshot on the manifest delivers changes", async () => {
    const world = new World();
    try {
      const a = await world.device().open({ backend: make() });
      const b = await world.device().open({ backend: make() });
      await b.link({ token: await a.exportToken() });
      await a.set({ live: 1 });
      await a.syncNow();
      await expect
        .poll(async () => (await b.get("live")).live, { timeout: 10_000 })
        .toBe(1);
    } finally {
      world.close();
    }
  });
});

// A real emulator rules check validates the packaged algorithm, including
// Firestore permission-denied for a forged update and both query forms.
describe("FS-10 setup check against shipped emulator rules", () => {
  it("passes on a fresh run and a second run without saving secrets", async () => {
    // The checker owns its SDK connection and closes it. Release the suite's
    // earlier shared connections before opening that standalone connection.
    await Promise.all(opened.splice(0).map((backend) => backend.close()));
    for (let run = 0; run < 2; run++) {
      const messages: string[] = [];
      await checkFirestore(config, (line) => messages.push(line));
      expect(messages).toEqual([
        "PASS create-read",
        "PASS forged-update",
        "PASS list",
        "PASS in-query",
      ]);
    }
  });
});
