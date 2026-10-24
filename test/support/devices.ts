// Simulated devices and tabs for integration tests: each device has its own
// IndexedDB (or memory cache), lock namespace, broadcast channels and network
// switch; all of them share one MemoryBackend store.
import { IDBFactory } from "fake-indexeddb";
import { MemoryBackend } from "../../src/backends/memory.js";
import { IdbCache } from "../../src/cache/indexeddb.js";
import { MemoryCache, MemoryDevice } from "../../src/cache/memory.js";
import { generateToken, remoteOf } from "../../src/core.js";
import { burrow } from "../../src/index.js";
import { type OfflineEnv, createOffline } from "../../src/offline.js";
import type {
  BurrowConfig,
  BurrowStorage,
  OfflineStorage,
  StoredDocument,
} from "../../src/types.js";

let seq = 0;

/**
 * Web Locks for one device: exclusive, per name, in request order. Node has no
 * navigator.locks, and browsers share it between the tabs of a profile.
 */
function deviceLocks(): LockManager {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name: string, fn: () => Promise<unknown>) {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => fn());
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  } as unknown as LockManager;
}

export class World {
  readonly store = new Map<string, StoredDocument>();
  readonly opened: BurrowStorage[] = [];
  devices: Device[] = [];
  #token: Promise<string> | undefined;
  /** One token shared by every device that does not pass its own. */
  token(): Promise<string> {
    return (this.#token ??= generateToken());
  }
  device(
    opts: { cache?: "indexeddb" | "memory"; latencyMs?: number } = {},
  ): Device {
    const d = new Device(this, opts);
    this.devices.push(d);
    return d;
  }
  /** Close every store opened in this world (timers, channels). */
  close(): void {
    for (const s of this.opened.splice(0)) s.close();
  }
}

export class Device {
  readonly ns = `dev${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  readonly idb = new IDBFactory();
  readonly mem = new MemoryDevice();
  readonly backend: MemoryBackend;
  readonly kind: "indexeddb" | "memory";
  readonly visibility = {
    visibilityState: "visible" as DocumentVisibilityState,
  };
  readonly win = new EventTarget();
  readonly locks = deviceLocks();
  /** The browser's idea of connectivity (navigator.onLine). */
  online = true;
  constructor(
    readonly world: World,
    opts: { cache?: "indexeddb" | "memory"; latencyMs?: number },
  ) {
    this.backend = new MemoryBackend({
      store: world.store,
      latencyMs: opts.latencyMs,
    });
    this.kind = opts.cache ?? "indexeddb";
  }

  /** The core for `app` "test" with the world's token. */
  async core(config: Partial<BurrowConfig> = {}): Promise<BurrowStorage> {
    const s = await burrow({
      app: "test",
      backend: this.backend,
      token: await this.world.token(),
      ...config,
    });
    this.world.opened.push(s);
    return s;
  }

  /**
   * A new tab (page) on this device: shares IndexedDB, locks and channels with
   * its other tabs.
   */
  env(overrides: Partial<OfflineEnv> = {}): OfflineEnv {
    return {
      ns: this.ns,
      openCache: (app, identity) =>
        this.kind === "memory"
          ? Promise.resolve(new MemoryCache(app, identity, this.mem))
          : IdbCache.open(app, identity, this.idb),
      channel: (name) => new BroadcastChannel(`${this.ns}:${name}`),
      locks: this.locks,
      win: this.win,
      doc: this.visibility,
      online: () => this.online,
      waitMs: 1_000,
      ...overrides,
    };
  }

  /** The offline wrapper over a new core: one tab of this device. */
  async open(
    config: Partial<BurrowConfig> = {},
    env = this.env(),
  ): Promise<OfflineStorage> {
    const s = await createOffline(await this.core(config), env);
    this.world.opened.push(s);
    return s;
  }

  /** This device's local copy for `app` and the world's (or a given) token. */
  async localItems(app = "test", token?: string) {
    const core = await burrow({
      app,
      backend: this.backend,
      token: token ?? (await this.world.token()),
    });
    const identity = remoteOf(core)!.identity;
    core.close();
    const cache =
      this.kind === "memory"
        ? new MemoryCache(app, identity, this.mem)
        : await IdbCache.open(app, identity, this.idb);
    try {
      return await cache.loadItems();
    } finally {
      cache.close();
    }
  }

  /** How many unsynced writes the local copy holds. */
  async dirty(app?: string, token?: string): Promise<number> {
    return [...(await this.localItems(app, token)).values()].filter(
      (e) => e.dirty,
    ).length;
  }

  /** Go offline or back online, as the browser reports it. */
  setOnline(online: boolean): void {
    this.online = online;
    this.backend.failWith = online ? null : "network";
    if (online) this.win.dispatchEvent(new Event("online"));
  }
}

/** Wait until `fn` returns truthy. */
export async function until(fn: () => unknown, ms = 5_000): Promise<void> {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Resolve once the store has no running or scheduled sync work. */
export async function settle(a: OfflineStorage): Promise<void> {
  await a.syncNow().catch(() => {});
}
