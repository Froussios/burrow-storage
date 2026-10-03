import type { AppMeta, Cache, CachedItem, DeviceMeta } from "./types.js";

/** Holds what a device would keep in IndexedDB. One per simulated device; the page has one. */
export class MemoryDevice {
  readonly device: DeviceMeta = {};
  readonly apps = new Map<string, { items: Map<string, CachedItem>; meta: AppMeta }>();
}

const pageDevice = new MemoryDevice();

const copy = <T>(v: T): T => structuredClone(v);

/** SYNC-1: the memory cache, for tests and private-mode fallback (SYNC-4). */
export class MemoryCache implements Cache {
  readonly kind = "memory" as const;
  readonly #dev: MemoryDevice;
  readonly #app: { items: Map<string, CachedItem>; meta: AppMeta };

  constructor(app: string, device: MemoryDevice = pageDevice) {
    this.#dev = device;
    let a = device.apps.get(app);
    if (!a) device.apps.set(app, (a = { items: new Map(), meta: {} }));
    this.#app = a;
  }

  async loadItems() { return new Map([...this.#app.items].map(([k, v]) => [k, copy(v)])); }

  async putItems(entries: Iterable<[string, CachedItem | null]>) {
    for (const [k, v] of entries) v ? this.#app.items.set(k, copy(v)) : this.#app.items.delete(k);
  }

  async updateItems(keys: string[], fn: (key: string, cur: CachedItem | undefined) => CachedItem | null | undefined) {
    const out = new Map<string, CachedItem | null>();
    for (const k of keys) {
      const cur = this.#app.items.get(k);
      const next = fn(k, cur && copy(cur));
      if (next === undefined) continue;
      next ? this.#app.items.set(k, copy(next)) : this.#app.items.delete(k);
      out.set(k, next && copy(next));
    }
    return out;
  }

  async clearItems() { this.#app.items.clear(); }
  async getMeta() { return copy(this.#app.meta); }
  async setMeta(patch: Partial<AppMeta>) { Object.assign(this.#app.meta, copy(patch)); }
  async getDevice() { return { ...this.#dev.device }; }

  async setDevice(patch: Partial<DeviceMeta>) {
    for (const [k, v] of Object.entries(patch) as [keyof DeviceMeta, unknown][]) {
      if (v === undefined) delete this.#dev.device[k];
      else (this.#dev.device as Record<string, unknown>)[k] = v;
    }
  }

  close() {}
}
