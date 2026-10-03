// SYNC-1: one IndexedDB database per origin named "burrow", one object store per app, so clearing
// one app never touches another. "_meta" holds per-app sync state, "_device" the wrapped secret.
import type { AppMeta, Cache, CachedItem, DeviceMeta } from "./types.js";

const DB = "burrow";
const META = "_meta";
const DEVICE = "_device";
const storeFor = (app: string) => "app:" + app;

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function openDb(idb: IDBFactory, version?: number, stores: string[] = []): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = version ? idb.open(DB, version) : idb.open(DB);
    r.onupgradeneeded = () => {
      for (const s of [META, DEVICE, ...stores]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    // Another tab still holds the old version open; it closes on versionchange and we proceed.
    r.onblocked = () => {};
  });
}

export class IdbCache implements Cache {
  readonly kind = "indexeddb" as const;
  readonly #idb: IDBFactory;
  readonly #store: string;
  #db: Promise<IDBDatabase> | null = null;

  private constructor(idb: IDBFactory, app: string) {
    this.#idb = idb;
    this.#store = storeFor(app);
  }

  /** Opens (creating the app's store if needed). Rejects if IndexedDB is unusable (SYNC-4). */
  static async open(app: string, idb: IDBFactory | null = globalThis.indexedDB ?? null): Promise<IdbCache> {
    if (!idb) throw new Error("IndexedDB unavailable");
    const c = new IdbCache(idb, app);
    await c.#conn();
    return c;
  }

  #conn(): Promise<IDBDatabase> {
    return (this.#db ??= this.#connect().catch((e) => { this.#db = null; throw e; }));
  }

  async #connect(): Promise<IDBDatabase> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const db = await openDb(this.#idb);
      const need = [META, DEVICE, this.#store].some((s) => !db.objectStoreNames.contains(s));
      if (!need) return this.#watch(db);
      const v = db.version + 1;
      db.close();
      try {
        const up = await openDb(this.#idb, v, [this.#store]);
        if (up.objectStoreNames.contains(this.#store)) return this.#watch(up);
        up.close();
      } catch (e) {
        // VersionError: another tab upgraded first. Retry from the new version.
        if ((e as DOMException)?.name !== "VersionError") throw e;
      }
    }
    throw new Error("could not create the IndexedDB object store");
  }

  #watch(db: IDBDatabase): IDBDatabase {
    // Another tab adding an app's store bumps the version: let it, and reconnect lazily.
    db.onversionchange = () => { db.close(); this.#db = null; };
    return db;
  }

  async #tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
    const db = await this.#conn();
    const t = db.transaction(stores, mode);
    const done = new Promise<void>((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error ?? new Error("transaction aborted"));
    });
    const out = await fn(t);
    await done;
    return out;
  }

  loadItems(): Promise<Map<string, CachedItem>> {
    return this.#tx([this.#store], "readonly", async (t) => {
      const s = t.objectStore(this.#store);
      const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return new Map(keys.map((k, i) => [k as string, vals[i] as CachedItem]));
    });
  }

  putItems(entries: Iterable<[string, CachedItem | null]>): Promise<void> {
    const list = [...entries];
    if (!list.length) return Promise.resolve();
    return this.#tx([this.#store], "readwrite", (t) => {
      const s = t.objectStore(this.#store);
      for (const [k, v] of list) v ? s.put(v, k) : s.delete(k);
    });
  }

  updateItems(keys: string[], fn: (key: string, cur: CachedItem | undefined) => CachedItem | null | undefined): Promise<Map<string, CachedItem | null>> {
    const out = new Map<string, CachedItem | null>();
    if (!keys.length) return Promise.resolve(out);
    return this.#tx([this.#store], "readwrite", async (t) => {
      const s = t.objectStore(this.#store);
      const curs = await Promise.all(keys.map((k) => req(s.get(k)) as Promise<CachedItem | undefined>));
      keys.forEach((k, i) => {
        const next = fn(k, curs[i]);
        if (next === undefined) return;
        next ? s.put(next, k) : s.delete(k);
        out.set(k, next);
      });
      return out;
    });
  }

  clearItems(): Promise<void> {
    return this.#tx([this.#store], "readwrite", (t) => { t.objectStore(this.#store).clear(); });
  }

  getMeta(): Promise<AppMeta> {
    return this.#tx([META], "readonly", async (t) => (await req(t.objectStore(META).get(this.#store))) ?? {});
  }

  setMeta(patch: Partial<AppMeta>): Promise<void> {
    return this.#tx([META], "readwrite", async (t) => {
      const s = t.objectStore(META);
      const cur = ((await req(s.get(this.#store))) ?? {}) as AppMeta;
      s.put({ ...cur, ...patch }, this.#store);
    });
  }

  getDevice(): Promise<DeviceMeta> {
    return this.#tx([DEVICE], "readonly", async (t) => {
      const s = t.objectStore(DEVICE);
      const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return Object.fromEntries(keys.map((k, i) => [k, vals[i]])) as DeviceMeta;
    });
  }

  setDevice(patch: Partial<DeviceMeta>): Promise<void> {
    return this.#tx([DEVICE], "readwrite", (t) => {
      const s = t.objectStore(DEVICE);
      for (const [k, v] of Object.entries(patch)) v === undefined ? s.delete(k) : s.put(v, k);
    });
  }

  close(): void {
    void this.#db?.then((db) => db.close(), () => {});
    this.#db = null;
  }
}
