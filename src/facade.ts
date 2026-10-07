// API-9..12: a synchronous DOM Storage over the in-memory mirror, so
// `localStorage` call sites swap with no other change. Writes are visible at
// once and persisted in the background.

/** The slice of the core the facade needs. */
export interface FacadeHost {
  readSync(key: string): unknown;
  keysSync(): string[];
  writeSync(entries: [string, unknown][], removals: string[]): void;
}

const METHODS = new Set([
  "length",
  "key",
  "getItem",
  "setItem",
  "removeItem",
  "clear",
]);

// Storage holds strings. A value written through the async API is shown as its
// JSON text.
const asString = (v: unknown): string | null =>
  v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);

class BurrowStorage {
  readonly #host: FacadeHost;
  constructor(host: FacadeHost) {
    this.#host = host;
  }

  get length(): number {
    return this.#host.keysSync().length;
  }
  key(index: number): string | null {
    return this.#host.keysSync()[index] ?? null;
  }
  getItem(key: string): string | null {
    return asString(this.#host.readSync(String(key)));
  }
  setItem(key: string, value: string): void {
    this.#host.writeSync([[String(key), String(value)]], []);
  }
  removeItem(key: string): void {
    this.#host.writeSync([], [String(key)]);
  }
  clear(): void {
    this.#host.writeSync([], this.#host.keysSync());
  }
  get [Symbol.toStringTag](): string {
    return "Storage";
  }
}

/**
 * Storage also exposes items as properties (`s.theme`, `s["theme"] = "dark"`,
 * `delete s.theme`).
 */
export function createFacade(host: FacadeHost): Storage {
  const target = new BurrowStorage(host);
  const own = (p: string | symbol): p is string =>
    typeof p === "string" && !METHODS.has(p) && !(p in BurrowStorage.prototype);
  return new Proxy(target, {
    get(t, p) {
      if (own(p)) return t.getItem(p) ?? undefined;
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, p, v) {
      if (!own(p)) return Reflect.set(t, p, v);
      t.setItem(p, v);
      return true;
    },
    has(t, p) {
      return own(p) ? t.getItem(p) !== null : p in t;
    },
    deleteProperty(t, p) {
      if (own(p)) t.removeItem(p);
      return true;
    },
    ownKeys() {
      return host.keysSync();
    },
    getOwnPropertyDescriptor(t, p) {
      if (!own(p)) return undefined;
      const v = t.getItem(p);
      return v === null
        ? undefined
        : { value: v, writable: true, enumerable: true, configurable: true };
    },
  }) as unknown as Storage;
}
