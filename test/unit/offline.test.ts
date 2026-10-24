// The optional offline wrapper (D-57): the same interface as the core,
// network first, a plaintext copy per app and token, unsynced writes kept and
// replayed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../src/backends/memory.js";
import { dbName } from "../../src/cache/indexeddb.js";
import { deriveAppKeys, docId } from "../../src/codec/derive.js";
import { decodeToken } from "../../src/codec/token.js";
import { generateToken } from "../../src/core.js";
import { burrow } from "../../src/index.js";
import { createOffline } from "../../src/offline.js";
import type {
  BurrowStorage,
  ChangedEvent,
  OfflineStorage,
  StatusEvent,
} from "../../src/types.js";
import { type Device, World, settle, until } from "../support/devices.js";

let world: World;
afterEach(() => {
  world?.close();
  vi.restoreAllMocks();
});
const fresh = () => (world = new World());

/** Every value in one fake-IndexedDB database, as JSON text. */
async function dumpIdb(d: Device, name: string): Promise<string> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = d.idb.open(name);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const out: unknown[] = [];
  for (const store of [...db.objectStoreNames]) {
    const t = db.transaction(store, "readonly").objectStore(store);
    const [keys, vals] = await Promise.all(
      [t.getAllKeys(), t.getAll()].map(
        (r) =>
          new Promise<unknown[]>((res) => {
            r.onsuccess = () => res(r.result as unknown[]);
          }),
      ),
    );
    out.push({ store, keys, vals });
  }
  db.close();
  return JSON.stringify(out);
}

describe("D-57 one interface for core and wrapper", () => {
  it("the core and the wrapper are assignable to the same type and behave alike online", async () => {
    const w = fresh();
    const stores: BurrowStorage[] = [
      await w.device().core(),
      await w.device().open(),
    ];
    for (const [i, s] of stores.entries()) {
      await s.set({ [`k${i}`]: i, shared: i });
      await s.remove(`missing${i}`);
    }
    for (const s of stores)
      expect(await s.get()).toEqual({ k0: 0, k1: 1, shared: 1 });
    await stores[0]!.clear();
    expect(await stores[1]!.get()).toEqual({});
  });

  it("offline() takes only a store from burrow(), once, and not after close()", async () => {
    const w = fresh();
    const d = w.device();
    await expect(createOffline({} as BurrowStorage, d.env())).rejects.toThrow(
      TypeError,
    );
    const core = await d.core();
    const local = await createOffline(core, d.env());
    await expect(createOffline(core, d.env())).rejects.toThrow(TypeError);
    local.close();
    const closed = await d.core();
    closed.close();
    await expect(createOffline(closed, d.env())).rejects.toMatchObject({
      code: "closed",
    });
  });

  it("close() closes the core it wraps; later calls reject closed", async () => {
    const w = fresh();
    const d = w.device();
    const core = await d.core();
    const local = await createOffline(core, d.env());
    local.close();
    await expect(core.get()).rejects.toMatchObject({ code: "closed" });
    await expect(local.get()).rejects.toMatchObject({ code: "closed" });
    await expect(local.set({ k: 1 })).rejects.toMatchObject({
      code: "closed",
    });
  });
});

describe("API-3/API-6 network first, local fallback", () => {
  it("reads go to the store: a value written elsewhere is returned at once", async () => {
    const w = fresh();
    const a = await w.device().open();
    await a.get(); // copy is current
    const b = await w.device().core();
    await b.set({ theme: "dark" });
    const events: ChangedEvent[] = [];
    a.onChanged.addListener((e) => events.push(e));
    expect(await a.get("theme")).toEqual({ theme: "dark" });
    expect(events).toEqual([
      { source: "remote", changes: { theme: { newValue: "dark" } } },
    ]);
  });

  it("API-6 set() resolves while the store is down; the write is kept and replayed", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    const statuses: StatusEvent[] = [];
    a.onStatus.addListener((s) => statuses.push(s));
    d.backend.failWith = "network";
    await a.set({ draft: "written offline" });
    expect(a.status).toBe("offline");
    expect(statuses.at(-1)).toMatchObject({
      status: "offline",
      error: { code: "backend" },
    });
    expect(await a.get()).toEqual({ draft: "written offline" });
    d.backend.failWith = null;
    await a.syncNow();
    expect(a.status).toBe("idle");
    expect(await (await w.device().core()).get()).toEqual({
      draft: "written offline",
    });
  });

  it("API-3 after a failure, reads answer locally without waiting on the store", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    await a.set({ k: 1 });
    d.backend.failWith = "network";
    await a.get(); // fails once, starts the backoff
    const gets = d.backend.stats.gets;
    expect(await a.get("k")).toEqual({ k: 1 });
    expect(d.backend.stats.gets).toBe(gets);
    await expect(a.syncNow()).rejects.toMatchObject({ code: "backend" });
  });

  it("navigator.onLine false: no network attempt; the online event replays", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    d.setOnline(false);
    const { gets, puts } = d.backend.stats;
    await a.set({ k: "queued" });
    expect(await a.get()).toEqual({ k: "queued" });
    expect(d.backend.stats).toEqual({ gets, puts });
    d.setOnline(true);
    const other = await w.device().core();
    await until(async () => (await other.get()).k === "queued");
  });

  it("a slow store: get() and set() answer locally after waitMs; the work lands later", async () => {
    const w = fresh();
    const d = w.device({ latencyMs: 60 });
    const a = await d.open({}, d.env({ waitMs: 20 }));
    const t0 = Date.now();
    await a.set({ k: "v" });
    expect(Date.now() - t0).toBeLessThan(200);
    const b = await w.device().core();
    await until(async () => (await b.get()).k === "v");
    await b.set({ k: "remote" });
    const events: ChangedEvent[] = [];
    a.onChanged.addListener((e) => events.push(e));
    expect(await a.get("k")).toEqual({ k: "v" }); // answered locally
    await until(() => events.length);
    expect(events[0]).toEqual({
      source: "remote",
      changes: { k: { oldValue: "v", newValue: "remote" } },
    });
  });

  it("API-4/ENC-4 invalid writes reject before anything is stored locally", async () => {
    const a = await fresh().device().open();
    await expect(a.set({ ok: 1, bad: () => 1 })).rejects.toThrow(TypeError);
    await expect(a.set({ big: "x".repeat(200_001) })).rejects.toMatchObject({
      code: "item-too-large",
    });
    expect(await a.get()).toEqual({});
  });

  it("API-5 onChanged fires for local writes with chrome's shape, skipping no-ops", async () => {
    const a = await fresh().device().open();
    const events: ChangedEvent[] = [];
    a.onChanged.addListener((e) => events.push(e));
    await a.set({ k: 1 });
    await a.set({ k: 1 });
    await a.set({ k: 2 });
    await a.remove(["k", "missing"]);
    expect(events).toEqual([
      { source: "local", changes: { k: { newValue: 1 } } },
      { source: "local", changes: { k: { oldValue: 1, newValue: 2 } } },
      { source: "local", changes: { k: { oldValue: 2 } } },
    ]);
  });
});

describe("D-57 offline initialisation and the local copy", () => {
  it("opens from the device with the token while the store is unreachable", async () => {
    const w = fresh();
    const d = w.device();
    const first = await d.open();
    await first.set({ theme: "dark" });
    first.close();
    d.setOnline(false);
    const a = await d.open();
    expect(a.status).toBe("offline");
    expect(await a.get()).toEqual({ theme: "dark" });
    await a.set({ theme: "light" });
    d.setOnline(true);
    const other = await w.device().core();
    await until(async () => (await other.get()).theme === "light");
  });

  it("SYNC-9 unsynced writes survive closing the page and are replayed by the next open", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    d.setOnline(false);
    await a.set({ k: "unsynced" });
    a.close();
    d.setOnline(true);
    await d.open();
    const other = await w.device().core();
    await until(async () => (await other.get()).k === "unsynced");
  });

  it("D-57 the local copy is plaintext items and sync state; never the token or a key", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    await a.set({ theme: "dark" });
    await settle(a);
    const token = await w.token();
    const secret = await decodeToken(token);
    const keys = await deriveAppKeys(secret, "test");
    const names = (await d.idb.databases()).map((x) => x.name!);
    expect(names).toHaveLength(1);
    const dump = await dumpIdb(d, names[0]!);
    expect(dump).toContain("dark"); // plaintext, by design
    for (const secretish of [
      token,
      token.replace(/-/g, ""),
      Buffer.from(secret).toString("hex"),
      Buffer.from(secret).toString("base64"),
      keys.base,
      await docId(keys, "theme"),
    ])
      expect(dump).not.toContain(secretish);
    expect(dump).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it("D-57 each token has its own copy; switching back finds its unsynced writes", async () => {
    const w = fresh();
    const d = w.device();
    const t1 = await w.token();
    const t2 = await generateToken();
    const a = await d.open({ token: t1 });
    d.setOnline(false);
    await a.set({ who: "first, unsynced" });
    a.close();
    const b = await d.open({ token: t2 });
    expect(await b.get()).toEqual({});
    await b.set({ who: "second" });
    b.close();
    expect(await d.idb.databases()).toHaveLength(2);
    d.setOnline(true);
    const again = await d.open({ token: t1 });
    expect(await again.get()).toEqual({ who: "first, unsynced" });
    await settle(again);
    expect(await (await w.device().core({ token: t1 })).get()).toEqual({
      who: "first, unsynced",
    });
  });

  it("D-54 apps on one device keep separate copies", async () => {
    const w = fresh();
    const d = w.device();
    const one = await d.open({ app: "one" });
    const two = await d.open({ app: "two" });
    await one.set({ k: "one" });
    expect(await two.get()).toEqual({});
    const names = (await d.idb.databases()).map((x) => x.name).sort();
    expect(names).toHaveLength(2);
    expect(names.every((n) => /^burrow:(one|two):[0-9a-f]{16}$/.test(n!))).toBe(
      true,
    );
  });

  it("SYNC-4 when IndexedDB cannot be opened, the wrapper runs on memory with status offline", async () => {
    const w = fresh();
    const d = w.device();
    const env = d.env();
    env.openCache = async () => {
      throw new DOMException("The user denied permission", "InvalidStateError");
    };
    const a = await d.open({ app: "sync4" }, env);
    expect(["offline", "syncing"]).toContain(a.status);
    await a.set({ k: "from private mode" });
    await a.syncNow();
    expect(a.status).toBe("idle");
    expect(await d.idb.databases()).toEqual([]);
    expect(await (await w.device().core({ app: "sync4" })).get()).toEqual({
      k: "from private mode",
    });
  });

  it("API-8 forget() refuses to orphan unsynced writes, then deletes the copy", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    await a.set({ synced: 1 });
    d.setOnline(false);
    await a.set({ pending: 2 });
    await expect(a.forget()).rejects.toMatchObject({ code: "would-orphan" });
    expect(await a.get()).toEqual({ synced: 1, pending: 2 });
    await a.forget({ discardLocal: true });
    expect(await d.idb.databases()).toEqual([]);
    await expect(a.get()).rejects.toMatchObject({ code: "closed" });
    d.setOnline(true);
    expect(await (await w.device().core()).get()).toEqual({ synced: 1 });
  });

  it("API-8 forget() pushes unsynced writes first when it can", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    d.setOnline(false);
    await a.set({ pending: 1 });
    d.online = true;
    d.backend.failWith = null;
    await a.forget();
    expect(await (await w.device().core()).get()).toEqual({ pending: 1 });
    expect(await d.idb.databases()).toEqual([]);
  });
});

describe("SYNC-10 replaying queued writes", () => {
  async function pair() {
    const w = fresh();
    const A = w.device(),
      B = w.device();
    const a = await A.open();
    const b = await B.open();
    return { w, A, B, a, b };
  }

  it("different keys edited offline on two devices converge with both changes", async () => {
    const { a, b, A, B } = await pair();
    A.setOnline(false);
    B.setOnline(false);
    await a.set({ fromA: 1 });
    await b.set({ fromB: 2 });
    A.setOnline(true);
    B.setOnline(true);
    await Promise.all([settle(a), settle(b)]);
    await settle(a);
    expect(await a.get()).toEqual({ fromA: 1, fromB: 2 });
    expect(await b.get()).toEqual({ fromA: 1, fromB: 2 });
  });

  it("an older offline write loses to a newer write made online elsewhere", async () => {
    const { a, b, A } = await pair();
    A.setOnline(false);
    await a.set({ k: "offline on A" });
    await new Promise((r) => setTimeout(r, 5));
    await b.set({ k: "online on B, later" });
    const events: ChangedEvent[] = [];
    a.onChanged.addListener((e) => events.push(e));
    A.setOnline(true);
    await settle(a);
    expect(await a.get()).toEqual({ k: "online on B, later" });
    expect(events).toContainEqual({
      source: "remote",
      changes: {
        k: { oldValue: "offline on A", newValue: "online on B, later" },
      },
    });
  });

  it("a newer offline write wins over an older remote one when it is replayed", async () => {
    const { a, b, A } = await pair();
    await b.set({ k: "online on B" });
    A.setOnline(false);
    await new Promise((r) => setTimeout(r, 5));
    await a.set({ k: "offline on A, later" });
    A.setOnline(true);
    await settle(a);
    expect(await b.get()).toEqual({ k: "offline on A, later" });
  });

  it("SYNC-12 a delete made offline is replayed; a stale device does not resurrect the key", async () => {
    const { w, a, b, A } = await pair();
    await a.set({ k: 1, keep: 2 });
    expect(await b.get()).toEqual({ k: 1, keep: 2 });
    const C = w.device();
    const c = await C.open();
    await c.get();
    C.setOnline(false);
    A.setOnline(false);
    await a.remove("k");
    A.setOnline(true);
    await settle(a);
    expect(await b.get()).toEqual({ keep: 2 });
    C.setOnline(true);
    await settle(c);
    expect(await c.get()).toEqual({ keep: 2 });
  });

  it("SYNC-12 a delete queued offline and repeated online still beats an older write queued elsewhere", async () => {
    const { a, b, A, B } = await pair();
    A.setOnline(false);
    B.setOnline(false);
    await b.set({ k: "older, queued on B" });
    await new Promise((r) => setTimeout(r, 5));
    await a.set({ k: "queued on A" });
    await a.remove("k"); // a queued tombstone; the store never had k
    // Back online without the event, so no background sync replays it first.
    A.online = true;
    A.backend.failWith = null;
    // k is not shown any more: only the queued delete goes out.
    await a.remove("k");
    await settle(a);
    B.setOnline(true);
    await settle(b);
    await settle(a);
    expect(await a.get()).toEqual({});
    expect(await b.get()).toEqual({});
  });

  it("an online set() overwrites even when the other device's clock is ahead", async () => {
    const { a, b } = await pair();
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + 3_600_000);
    await b.set({ k: "fast clock" });
    vi.restoreAllMocks();
    await a.set({ k: "slow clock, later" });
    expect(await b.get("k")).toEqual({ k: "slow clock, later" });
  });

  it("D-20 a write made while a replay is in flight stays dirty and is pushed next", async () => {
    const w = fresh();
    const A = w.device({ latencyMs: 20 });
    const a = await A.open({}, A.env({ waitMs: 1 }));
    await a.set({ k: 1 });
    await a.set({ k: 2 });
    await a.set({ k: 3 });
    await until(async () => {
      await settle(a);
      return (await (await w.device().core()).get()).k === 3;
    });
  });
});

describe("SYNC-14 tabs", () => {
  it("a write in one tab fires onChanged in the other and is visible there", async () => {
    const w = fresh();
    const d = w.device();
    const t1 = await d.open();
    const t2 = await d.open();
    const events: ChangedEvent[] = [];
    t2.onChanged.addListener((e) => events.push(e));
    d.setOnline(false);
    await t1.set({ k: "from tab 1" });
    await until(() => events.length);
    expect(events[0]).toEqual({
      source: "local",
      changes: { k: { newValue: "from tab 1" } },
    });
    expect(await t2.get()).toEqual({ k: "from tab 1" });
  });

  it("tabs replaying the same queued write push it once", async () => {
    const w = fresh();
    const d = w.device();
    const t1 = await d.open();
    const t2 = await d.open();
    await t1.get();
    d.setOnline(false);
    await t1.set({ k: "queued" });
    d.online = true;
    d.backend.failWith = null;
    const puts = d.backend.stats.puts;
    await Promise.all([t1.syncNow(), t2.syncNow()]);
    expect(d.backend.stats.puts - puts).toBe(2); // one item, one manifest
  });

  it("forget() in one tab closes the other", async () => {
    const w = fresh();
    const d = w.device();
    const t1 = await d.open();
    const t2 = await d.open();
    await t1.forget();
    await until(async () =>
      t2.get().then(
        () => false,
        (e) => e.code === "closed",
      ),
    );
  });
});

describe("remote changes and status", () => {
  it("subscribe: a manifest change elsewhere reaches the local copy without a read", async () => {
    const w = fresh();
    const a = await w.device().open();
    await settle(a);
    const events: ChangedEvent[] = [];
    a.onChanged.addListener((e) => events.push(e));
    await (await w.device().core()).set({ live: 1 });
    await until(() => events.length);
    expect(events[0]).toEqual({
      source: "remote",
      changes: { live: { newValue: 1 } },
    });
  });

  it("SYNC-6 becoming visible refreshes the copy", async () => {
    const w = fresh();
    const d = w.device();
    const backend = new MemoryBackend({ store: w.store });
    Object.defineProperty(backend, "capabilities", {
      value: { writeAuth: true, subscribe: false },
    });
    const a = await d.open({ backend });
    await settle(a);
    await (await w.device().core()).set({ k: "elsewhere" });
    const events: ChangedEvent[] = [];
    a.onChanged.addListener((e) => events.push(e));
    d.visibility.visibilityState = "visible";
    d.win.dispatchEvent(new Event("visibilitychange"));
    await until(() => events.length);
  });

  it("ENC-6 a document that does not decrypt pauses remote work and keeps the copy", async () => {
    const w = fresh();
    const d = w.device();
    const a = await d.open();
    await a.set({ k: "kept" });
    await settle(a); // the first-use renewal has run
    const keys = await deriveAppKeys(
      await decodeToken(await w.token()),
      "test",
    );
    const id = await docId(keys, "k");
    const env = w.store.get(id) as { ct: string };
    w.store.set(id, {
      ...(env as object),
      ct: env.ct.replace(/^./, (c) => (c === "A" ? "B" : "A")),
    } as never);
    expect(await a.get("k")).toEqual({ k: "kept" });
    expect(a.status).toBe("error");
    await expect(a.syncNow()).rejects.toMatchObject({ code: "decrypt-failed" });
    const gets = d.backend.stats.gets;
    await a.set({ other: 1 });
    expect(await a.get()).toEqual({ k: "kept", other: 1 });
    expect(d.backend.stats.gets).toBe(gets);
  });

  it("quota failures report error.code = quota and keep the data", async () => {
    const d = fresh().device();
    const a = await d.open();
    d.backend.failWith = "quota";
    await a.set({ k: 1 });
    expect(a.status).toBe("offline");
    await expect(a.syncNow()).rejects.toMatchObject({ code: "quota" });
    expect(await a.get()).toEqual({ k: 1 });
  });

  it("the core underneath stays usable for online calls and is closed with the wrapper", async () => {
    const w = fresh();
    const d = w.device();
    const core = await burrow({
      app: "test",
      backend: d.backend,
      token: await w.token(),
    });
    const local: OfflineStorage = await createOffline(core, d.env());
    await local.set({ k: 1 });
    expect(await core.get()).toEqual({ k: 1 });
    local.close();
    await expect(core.get()).rejects.toMatchObject({ code: "closed" });
    expect(dbName("test", "x")).toBe("burrow:test:x");
  });
});
