// The same conformance suite, against FirestoreBackend talking to the Firestore
// emulator with firebase/firestore.rules loaded (run via
// `npm run test:firestore`).
import { afterAll, describe, expect, it } from "vitest";
import { FirestoreBackend } from "../../src/backends/firestore.js";
import { checkFirestore } from "../../src/setup/check.js";
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
const make = () => {
  const b = new FirestoreBackend(config);
  opened.push(b);
  return b;
};
afterAll(async () => {
  await Promise.all(opened.map((b) => b.close()));
});

backendConformance("FirestoreBackend (emulator)", make);

describe("Burrow over FirestoreBackend (emulator)", () => {
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
