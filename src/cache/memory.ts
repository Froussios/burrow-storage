import type { AppMeta, Cache, CachedItem, Updated } from "./types.js";

/**
 * Holds what a device would keep in IndexedDB. One per simulated device; the
 * page has one.
 */
export class MemoryDevice {
  readonly copies = new Map<string, MemoryCopy>();
}

interface MemoryCopy {
  items: Map<string, CachedItem>;
  meta: AppMeta;
}

const pageDevice = new MemoryDevice();

const copy = <T>(v: T): T => structuredClone(v);

/** SYNC-1: the memory cache, for tests and private-mode fallback (SYNC-4). */
export class MemoryCache implements Cache {
  readonly kind = "memory" as const;
  readonly #name: string;
  readonly #device: MemoryDevice;
  readonly #copy: MemoryCopy;

  constructor(
    app: string,
    identity: string,
    device: MemoryDevice = pageDevice,
  ) {
    this.#name = `${app}:${identity}`;
    this.#device = device;
    let c = device.copies.get(this.#name);
    if (!c) device.copies.set(this.#name, (c = { items: new Map(), meta: {} }));
    this.#copy = c;
  }

  async loadItems() {
    return new Map([...this.#copy.items].map(([k, v]) => [k, copy(v)]));
  }

  async getItems(keys: string[]) {
    const out = new Map<string, CachedItem>();
    for (const k of keys) {
      const v = this.#copy.items.get(k);
      if (v) out.set(k, copy(v));
    }
    return out;
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
    const changes: [string, CachedItem | undefined, CachedItem | null][] = [];
    for (const k of keys) {
      const cur = this.#copy.items.get(k);
      const next = fn(k, cur && copy(cur));
      if (next !== undefined) changes.push([k, cur, next && copy(next)]);
    }
    const out: Updated = new Map();
    for (const [k, before, v] of changes) {
      v ? this.#copy.items.set(k, v) : this.#copy.items.delete(k);
      out.set(k, [before && copy(before), v && copy(v)]);
    }
    return out;
  }

  async getMeta() {
    return copy(this.#copy.meta);
  }
  async setMeta(patch: Partial<AppMeta>) {
    Object.assign(this.#copy.meta, copy(patch));
  }
  async destroy() {
    if (this.#device.copies.get(this.#name) === this.#copy)
      this.#device.copies.delete(this.#name);
    this.#copy.items.clear();
    this.#copy.meta = {};
  }

  close() {}
}
