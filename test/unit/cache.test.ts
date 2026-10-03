import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IdbCache } from "../../src/cache/indexeddb.js";
import { MemoryCache, MemoryDevice } from "../../src/cache/memory.js";
import type { Cache } from "../../src/cache/types.js";

type Make = (app: string) => Promise<Cache>;

function cacheSuite(name: string, factory: () => Make) {
  describe(`SYNC-1..3 cache: ${name}`, () => {
    it("stores items, meta and device state", async () => {
      const make = factory();
      const c = await make("a");
      await c.putItems([["k", { value: { x: 1 }, ts: 5, dirty: true }], ["t", { ts: 6, deleted: true, rev: 2 }]]);
      expect(Object.fromEntries(await c.loadItems())).toEqual({ k: { value: { x: 1 }, ts: 5, dirty: true }, t: { ts: 6, deleted: true, rev: 2 } });
      await c.putItems([["k", null]]);
      expect([...(await c.loadItems()).keys()]).toEqual(["t"]);
      await c.setMeta({ manifestRev: 3 });
      await c.setMeta({ lastSyncAt: 9 });
      expect(await c.getMeta()).toEqual({ manifestRev: 3, lastSyncAt: 9 });
      await c.setDevice({ protection: "code", "p:cred": "abc" });
      await c.setDevice({ "p:cred": undefined });
      expect(await c.getDevice()).toEqual({ protection: "code" });
    });

    it("keeps apps apart: clearing one never touches another", async () => {
      const make = factory();
      const a = await make("a"), b = await make("b");
      await a.putItems([["k", { value: 1, ts: 1 }]]);
      await b.putItems([["k", { value: 2, ts: 1 }]]);
      await a.clearItems();
      expect((await a.loadItems()).size).toBe(0);
      expect((await b.loadItems()).get("k")?.value).toBe(2);
    });

    it("device state is shared by every app on the origin (KP-4)", async () => {
      const make = factory();
      const a = await make("a");
      await a.setDevice({ protection: "passkey" });
      expect((await (await make("b")).getDevice()).protection).toBe("passkey");
    });

    it("KP-2 persists a non-extractable CryptoKey", async () => {
      const make = factory();
      const kw = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
      await (await make("a")).setDevice({ kw, wrapped: new Uint8Array([1, 2, 3]) });
      const dev = await (await make("a")).getDevice();
      expect(dev.kw?.extractable).toBe(false);
      expect(dev.kw?.algorithm.name).toBe("AES-KW");
      expect([...dev.wrapped!]).toEqual([1, 2, 3]);
    });
  });
}

cacheSuite("memory", () => { const d = new MemoryDevice(); return async (app) => new MemoryCache(app, d); });
cacheSuite("indexeddb", () => { const idb = new IDBFactory(); return (app) => IdbCache.open(app, idb); });

describe("IdbCache across connections", () => {
  it("a new app's store is added while another connection is open (other tab)", async () => {
    const idb = new IDBFactory();
    const a = await IdbCache.open("a", idb);
    await a.putItems([["k", { value: 1, ts: 1 }]]);
    const b = await IdbCache.open("b", idb); // bumps the version; `a` closes and reconnects lazily
    await b.putItems([["k", { value: 2, ts: 1 }]]);
    expect((await a.loadItems()).get("k")?.value).toBe(1);
    await a.putItems([["j", { value: 3, ts: 1 }]]);
    expect((await (await IdbCache.open("a", idb)).loadItems()).size).toBe(2);
  });

  it("SYNC-4 rejects when IndexedDB is missing so the caller can fall back to memory", async () => {
    await expect(IdbCache.open("a", null)).rejects.toThrow();
  });
});
