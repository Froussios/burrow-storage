// The same conformance suite, against FirestoreBackend talking to the Firestore emulator
// with firebase/firestore.rules loaded (run via `npm run test:firestore`).
import { afterAll, describe, expect, it } from "vitest";
import { FirestoreBackend } from "../../src/backends/firestore.js";
import { World } from "../support/devices.js";
import { backendConformance } from "./suite.js";

const hostEnv = process.env.FIRESTORE_EMULATOR_HOST;
if (!hostEnv) throw new Error("run under the emulator: npm run test:firestore");
const [host, port] = hostEnv.split(":");
const emulator = { host: host!, port: Number(port) };
const config = { apiKey: "emulator", projectId: "burrow-rules-test", appId: "1:0:web:0", emulator };

const opened: FirestoreBackend[] = [];
const make = () => { const b = new FirestoreBackend(config); opened.push(b); return b; };
afterAll(async () => { await Promise.all(opened.map((b) => b.close())); });

backendConformance("FirestoreBackend (emulator)", make);

describe("Burrow over FirestoreBackend (emulator)", () => {
  it("two devices sync through the emulator", async () => {
    const world = new World();
    try {
      const A = world.device(), B = world.device();
      const a = await A.open({ backend: make() });
      const b = await B.open({ backend: make() });
      await a.set({ theme: "dark", draft: "hello" });
      await a.syncNow();
      await b.link({ code: await a.exportCode() });
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
      await b.link({ code: await a.exportCode() });
      await a.set({ live: 1 });
      await a.syncNow();
      await expect.poll(async () => (await b.get("live")).live, { timeout: 10_000 }).toBe(1);
    } finally {
      world.close();
    }
  });
});
