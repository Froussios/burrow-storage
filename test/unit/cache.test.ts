import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IdbCache } from "../../src/cache/indexeddb.js";
import { MemoryCache, MemoryDevice } from "../../src/cache/memory.js";
import type { Cache, CachedItem } from "../../src/cache/types.js";

type Make = (app: string, identity?: string) => Promise<Cache>;

const put = (c: Cache, entries: [string, CachedItem | null][]) =>
  c.updateItems(
    entries.map(([k]) => k),
    (k) => entries.find(([e]) => e === k)![1],
  );

function cacheSuite(name: string, factory: () => Make) {
  describe(`SYNC-1..3 cache: ${name}`, () => {
    it("stores items and meta; updateItems reports before and after", async () => {
      const make = factory();
      const c = await make("a");
      const first = await put(c, [
        ["k", { value: { x: 1 }, ts: 5, dirty: true }],
        ["t", { ts: 6, deleted: true, rev: 2 }],
      ]);
      expect(first.get("k")).toEqual([
        undefined,
        { value: { x: 1 }, ts: 5, dirty: true },
      ]);
      expect(Object.fromEntries(await c.loadItems())).toEqual({
        k: { value: { x: 1 }, ts: 5, dirty: true },
        t: { ts: 6, deleted: true, rev: 2 },
      });
      expect(Object.fromEntries(await c.getItems(["t", "missing"]))).toEqual({
        t: { ts: 6, deleted: true, rev: 2 },
      });
      const second = await put(c, [["k", null]]);
      expect(second.get("k")).toEqual([
        { value: { x: 1 }, ts: 5, dirty: true },
        null,
      ]);
      expect([...(await c.loadItems()).keys()]).toEqual(["t"]);
      await c.setMeta({ renewAt: 3 });
      await c.setMeta({ lastSyncAt: 9 });
      expect(await c.getMeta()).toEqual({ renewAt: 3, lastSyncAt: 9 });
    });

    it("updateItems leaves keys whose function returns undefined", async () => {
      const c = await factory()("a");
      await put(c, [["k", { value: 1, ts: 1 }]]);
      const out = await c.updateItems(["k", "j"], () => undefined);
      expect(out.size).toBe(0);
      expect((await c.loadItems()).get("k")).toEqual({ value: 1, ts: 1 });
    });

    it("SYNC-2 updateItems is atomic: a failing record mid-batch writes nothing", async () => {
      const make = factory();
      const c = await make("a");
      await put(c, [
        ["x", { value: 1, ts: 1 }],
        ["y", { value: 1, ts: 1 }],
      ]);
      // A function is not structured-cloneable (DataCloneError). Values pass
      // assertJson first, but any failure mid-batch must leave the copy as it
      // was.
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
      await put(c, [["after", { value: 3, ts: 5 }]]);
      expect((await c.loadItems()).size).toBe(3);
    });

    it("D-57 keeps apps and identities apart; destroy() removes one copy only", async () => {
      const make = factory();
      const a = await make("a", "id1"),
        a2 = await make("a", "id2"),
        b = await make("b", "id1");
      await put(a, [["k", { value: 1, ts: 1 }]]);
      await put(a2, [["k", { value: 2, ts: 1 }]]);
      await put(b, [["k", { value: 3, ts: 1 }]]);
      await a.setMeta({ renewAt: 1 });
      await a.destroy();
      const again = await make("a", "id1");
      expect((await again.loadItems()).size).toBe(0);
      expect(await again.getMeta()).toEqual({});
      expect((await a2.loadItems()).get("k")?.value).toBe(2);
      expect((await b.loadItems()).get("k")?.value).toBe(3);
    });
  });
}

cacheSuite("memory", () => {
  const d = new MemoryDevice();
  return async (app, identity = "0") => new MemoryCache(app, identity, d);
});
cacheSuite("indexeddb", () => {
  const idb = new IDBFactory();
  return (app, identity = "0") => IdbCache.open(app, identity, idb);
});

describe("IdbCache across connections", () => {
  it("one database per app and identity, named burrow:<app>:<identity>", async () => {
    const idb = new IDBFactory();
    await IdbCache.open("a", "f00d", idb);
    await IdbCache.open("b", "f00d", idb);
    expect((await idb.databases()).map((d) => d.name).sort()).toEqual([
      "burrow:a:f00d",
      "burrow:b:f00d",
    ]);
  });

  it("another tab's destroy() is not blocked by an open connection", async () => {
    const idb = new IDBFactory();
    const tab1 = await IdbCache.open("a", "x", idb);
    await put(tab1, [["k", { value: 1, ts: 1 }]]);
    const tab2 = await IdbCache.open("a", "x", idb);
    await tab2.destroy();
    expect(await idb.databases()).toEqual([]);
  });

  it("SYNC-4 rejects when IndexedDB is missing so the caller can fall back to memory", async () => {
    await expect(IdbCache.open("a", "x", null)).rejects.toThrow();
  });
});
