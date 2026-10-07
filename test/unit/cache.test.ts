import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IdbCache } from "../../src/cache/indexeddb.js";
import { MemoryCache, MemoryDevice } from "../../src/cache/memory.js";
import type { Cache, CachedItem } from "../../src/cache/types.js";

type Make = (app: string) => Promise<Cache>;

function cacheSuite(name: string, factory: () => Make) {
  describe(`SYNC-1..3 cache: ${name}`, () => {
    it("stores items, meta and device state", async () => {
      const make = factory();
      const c = await make("a");
      await c.putItems([
        ["k", { value: { x: 1 }, ts: 5, dirty: true }],
        ["t", { ts: 6, deleted: true, rev: 2 }],
      ]);
      expect(Object.fromEntries(await c.loadItems())).toEqual({
        k: { value: { x: 1 }, ts: 5, dirty: true },
        t: { ts: 6, deleted: true, rev: 2 },
      });
      await c.putItems([["k", null]]);
      expect([...(await c.loadItems()).keys()]).toEqual(["t"]);
      await c.setMeta({ manifestRev: 3 });
      await c.setMeta({ lastSyncAt: 9 });
      expect(await c.getMeta()).toEqual({ manifestRev: 3, lastSyncAt: 9 });
      await c.setDevice({ protection: "code", "p:cred": "abc" });
      await c.setDevice({ "p:cred": undefined });
      expect(await c.getDevice()).toEqual({ protection: "code" });
    });

    it("SYNC-2 putItems is atomic: one record that cannot be stored mid-batch writes nothing", async () => {
      const make = factory();
      const c = await make("a");
      await c.putItems([["keep", { value: "old", ts: 1 }]]);
      // A function is not structured-cloneable (DataCloneError). Core never
      // produces one (values pass assertJson first), but any failure mid-batch
      // must leave the cache as it was.
      const bad = { value: () => 1, ts: 3 } as unknown as CachedItem;
      await expect(
        c.putItems([
          ["first", { value: 1, ts: 2 }],
          ["keep", { value: "new", ts: 2 }],
          ["bad", bad],
          ["last", { value: 2, ts: 4 }],
        ]),
      ).rejects.toThrow();
      expect(Object.fromEntries(await c.loadItems())).toEqual({
        keep: { value: "old", ts: 1 },
      });
      // The cache is still usable afterwards.
      await c.putItems([["after", { value: 3, ts: 5 }]]);
      expect([...(await c.loadItems()).keys()].sort()).toEqual([
        "after",
        "keep",
      ]);
    });

    it("SYNC-2 updateItems is atomic too: a failing record mid-batch writes nothing", async () => {
      const make = factory();
      const c = await make("a");
      await c.putItems([
        ["x", { value: 1, ts: 1 }],
        ["y", { value: 1, ts: 1 }],
      ]);
      await expect(
        c.updateItems(["x", "y"], (k, cur) =>
          k === "y"
            ? ({ value: () => 2, ts: 2 } as unknown as CachedItem)
            : { ...cur!, value: 2, ts: 2 },
        ),
      ).rejects.toThrow();
      expect(Object.fromEntries(await c.loadItems())).toEqual({
        x: { value: 1, ts: 1 },
        y: { value: 1, ts: 1 },
      });
    });

    it("keeps apps apart: clearing one never touches another", async () => {
      const make = factory();
      const a = await make("a"),
        b = await make("b");
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
      const kw = await crypto.subtle.generateKey(
        { name: "AES-KW", length: 256 },
        false,
        ["wrapKey", "unwrapKey"],
      );
      await (
        await make("a")
      ).setDevice({ kw, wrapped: new Uint8Array([1, 2, 3]) });
      const dev = await (await make("a")).getDevice();
      expect(dev.kw?.extractable).toBe(false);
      expect(dev.kw?.algorithm.name).toBe("AES-KW");
      expect([...dev.wrapped!]).toEqual([1, 2, 3]);
    });
  });
}

cacheSuite("memory", () => {
  const d = new MemoryDevice();
  return async (app) => new MemoryCache(app, d);
});
cacheSuite("indexeddb", () => {
  const idb = new IDBFactory();
  return (app) => IdbCache.open(app, idb);
});

describe("IdbCache across connections", () => {
  it("a new app's store is added while another connection is open (other tab)", async () => {
    const idb = new IDBFactory();
    const a = await IdbCache.open("a", idb);
    await a.putItems([["k", { value: 1, ts: 1 }]]);
    // bumps the version; `a` closes and reconnects lazily
    const b = await IdbCache.open("b", idb);
    await b.putItems([["k", { value: 2, ts: 1 }]]);
    expect((await a.loadItems()).get("k")?.value).toBe(1);
    await a.putItems([["j", { value: 3, ts: 1 }]]);
    expect((await (await IdbCache.open("a", idb)).loadItems()).size).toBe(2);
  });

  it("SYNC-4 rejects when IndexedDB is missing so the caller can fall back to memory", async () => {
    await expect(IdbCache.open("a", null)).rejects.toThrow();
  });
});
