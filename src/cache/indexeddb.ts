// SYNC-1: one IndexedDB database per app and token, named
// "burrow:<app>:<identity>", so each identity's local copy is separate and can
// be deleted whole (D-57). "items" holds the plaintext items by key, "meta" the
// sync state. Nothing token-derived is stored except the identity in the name,
// a 64-bit fingerprint that cannot open or write anything (D-8).
import { BurrowError } from "../errors.js";
import type { AppMeta, Cache, CachedItem, Updated } from "./types.js";

const ITEMS = "items";
const META = "meta";

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

export const dbName = (app: string, identity: string): string =>
  `burrow:${app}:${identity}`;

export class IdbCache implements Cache {
  readonly kind = "indexeddb" as const;
  readonly #idb: IDBFactory;
  readonly #name: string;
  #db: Promise<IDBDatabase> | null = null;
  // Once closed or deleted, a late call must not create the database again.
  #closed = false;

  private constructor(idb: IDBFactory, name: string) {
    this.#idb = idb;
    this.#name = name;
  }

  /**
   * Opens (creating it if needed). Rejects if IndexedDB is unusable (SYNC-4).
   */
  static async open(
    app: string,
    identity: string,
    idb: IDBFactory | null = globalThis.indexedDB ?? null,
  ): Promise<IdbCache> {
    if (!idb) throw new Error("IndexedDB unavailable");
    const c = new IdbCache(idb, dbName(app, identity));
    await c.#conn();
    return c;
  }

  #conn(): Promise<IDBDatabase> {
    if (this.#closed)
      return Promise.reject(
        new BurrowError("closed", "the local copy is closed"),
      );
    return (this.#db ??= new Promise<IDBDatabase>((res, rej) => {
      const r = this.#idb.open(this.#name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(ITEMS);
        r.result.createObjectStore(META);
      };
      r.onsuccess = () => {
        // Another tab deleting this copy (forget()) must not be blocked by us.
        r.result.onversionchange = () => {
          r.result.close();
          this.close();
        };
        res(r.result);
      };
      r.onerror = () => rej(r.error);
    }).catch((e) => {
      this.#db = null;
      throw e;
    }));
  }

  async #tx<T>(
    stores: string[],
    mode: IDBTransactionMode,
    fn: (t: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.#conn();
    const t = db.transaction(stores, mode);
    const done = new Promise<void>((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error ?? new Error("transaction aborted"));
    });
    let out: T;
    try {
      out = await fn(t);
    } catch (e) {
      // A batch is all or nothing: requests already queued must not commit
      // (cache/types.ts).
      try {
        t.abort();
      } catch {
        /* already finished */
      }
      await done.catch(() => {});
      throw e;
    }
    await done;
    return out;
  }

  loadItems(): Promise<Map<string, CachedItem>> {
    return this.#tx([ITEMS], "readonly", async (t) => {
      const s = t.objectStore(ITEMS);
      const [keys, vals] = await Promise.all([
        req(s.getAllKeys()),
        req(s.getAll()),
      ]);
      return new Map(keys.map((k, i) => [k as string, vals[i] as CachedItem]));
    });
  }

  getItems(keys: string[]): Promise<Map<string, CachedItem>> {
    return this.#tx([ITEMS], "readonly", async (t) => {
      const s = t.objectStore(ITEMS);
      const vals = await Promise.all(
        keys.map((k) => req(s.get(k)) as Promise<CachedItem | undefined>),
      );
      const out = new Map<string, CachedItem>();
      keys.forEach((k, i) => vals[i] && out.set(k, vals[i]!));
      return out;
    });
  }

  updateItems(
    keys: string[],
    fn: (
      key: string,
      cur: CachedItem | undefined,
    ) => CachedItem | null | undefined,
  ): Promise<Updated> {
    const out: Updated = new Map();
    if (!keys.length) return Promise.resolve(out);
    return this.#tx([ITEMS], "readwrite", async (t) => {
      const s = t.objectStore(ITEMS);
      const curs = await Promise.all(
        keys.map((k) => req(s.get(k)) as Promise<CachedItem | undefined>),
      );
      keys.forEach((k, i) => {
        const next = fn(k, curs[i]);
        if (next === undefined) return;
        next ? s.put(next, k) : s.delete(k);
        out.set(k, [curs[i], next]);
      });
      return out;
    });
  }

  getMeta(): Promise<AppMeta> {
    return this.#tx(
      [META],
      "readonly",
      async (t) => (await req(t.objectStore(META).get(META))) ?? {},
    );
  }

  setMeta(patch: Partial<AppMeta>): Promise<void> {
    return this.#tx([META], "readwrite", async (t) => {
      const s = t.objectStore(META);
      const cur = ((await req(s.get(META))) ?? {}) as AppMeta;
      s.put({ ...cur, ...patch }, META);
    });
  }

  async destroy(): Promise<void> {
    this.close();
    await req(this.#idb.deleteDatabase(this.#name));
  }

  close(): void {
    this.#closed = true;
    void this.#db?.then(
      (db) => db.close(),
      () => {},
    );
    this.#db = null;
  }
}
