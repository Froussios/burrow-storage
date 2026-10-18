import type { AppMeta, Cache, CachedItem, StoredToken } from "./types.js";

/**
 * Holds what a device would keep in IndexedDB. One per simulated device; the
 * page has one.
 */
export class MemoryDevice {
  readonly apps = new Map<string, MemoryApp>();
}

interface MemoryApp {
  items: Map<string, CachedItem>;
  meta: AppMeta;
  token?: StoredToken;
}

const pageDevice = new MemoryDevice();

const copy = <T>(v: T): T => structuredClone(v);
// The CryptoKey is immutable and shared; the wrapped bytes are copied.
const copyToken = (t: StoredToken): StoredToken => ({
  ...t,
  wrapped: new Uint8Array(t.wrapped),
});

/** SYNC-1: the memory cache, for tests and private-mode fallback (SYNC-4). */
export class MemoryCache implements Cache {
  readonly kind = "memory" as const;
  readonly #app: MemoryApp;

  constructor(app: string, device: MemoryDevice = pageDevice) {
    let a = device.apps.get(app);
    if (!a) device.apps.set(app, (a = { items: new Map(), meta: {} }));
    this.#app = a;
  }

  async loadItems() {
    return new Map([...this.#app.items].map(([k, v]) => [k, copy(v)]));
  }

  async putItems(entries: Iterable<[string, CachedItem | null]>) {
    // Copy everything first so a value that cannot be cloned leaves the batch
    // unwritten.
    const list = [...entries].map(([k, v]) => [k, v && copy(v)] as const);
    for (const [k, v] of list)
      v ? this.#app.items.set(k, v) : this.#app.items.delete(k);
  }

  async updateItems(
    keys: string[],
    fn: (
      key: string,
      cur: CachedItem | undefined,
    ) => CachedItem | null | undefined,
  ) {
    // Compute and copy every change before applying any, so the batch is all or
    // nothing.
    const changes: [string, CachedItem | null][] = [];
    for (const k of keys) {
      const cur = this.#app.items.get(k);
      const next = fn(k, cur && copy(cur));
      if (next !== undefined) changes.push([k, next && copy(next)]);
    }
    const out = new Map<string, CachedItem | null>();
    for (const [k, v] of changes) {
      v ? this.#app.items.set(k, v) : this.#app.items.delete(k);
      out.set(k, v && copy(v));
    }
    return out;
  }

  async clearItems() {
    this.#app.items.clear();
  }
  async getMeta() {
    return copy(this.#app.meta);
  }
  async setMeta(patch: Partial<AppMeta>) {
    Object.assign(this.#app.meta, copy(patch));
  }
  async getToken() {
    return this.#app.token && copyToken(this.#app.token);
  }
  async setToken(token: StoredToken | null) {
    if (token) this.#app.token = copyToken(token);
    else delete this.#app.token;
  }

  close() {}
}
