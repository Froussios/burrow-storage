// Simulated devices and tabs for integration tests: each device has its own
// IndexedDB (or memory cache), lock namespace and broadcast channels; all of
// them share one MemoryBackend store.
import { IDBFactory } from "fake-indexeddb";
import { MemoryBackend } from "../../src/backends/memory.js";
import { IdbCache } from "../../src/cache/indexeddb.js";
import { MemoryCache, MemoryDevice } from "../../src/cache/memory.js";
import type { Core, Env } from "../../src/core.js";
import { createBurrow } from "../../src/index.js";
import type { BurrowConfig, Envelope } from "../../src/types.js";

let seq = 0;

export class World {
  readonly store = new Map<string, Envelope>();
  readonly areas: Core[] = [];
  devices: Device[] = [];
  device(
    opts: { cache?: "indexeddb" | "memory"; latencyMs?: number } = {},
  ): Device {
    const d = new Device(this, opts);
    this.devices.push(d);
    return d;
  }
  /** Stop every area opened in this world (timers, channels). */
  close(): void {
    for (const a of this.areas.splice(0)) a.close();
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
  location: { hash: string; href: string } | null = null;
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

  /**
   * A new tab (page) on this device: shares IndexedDB, locks and channels with
   * its other tabs.
   */
  env(): Env {
    return {
      ns: this.ns,
      openCache: (app, kind) =>
        kind === "memory" || this.kind === "memory"
          ? Promise.resolve(new MemoryCache(app, this.mem))
          : IdbCache.open(app, this.idb),
      channel: (name) => new BroadcastChannel(`${this.ns}:${name}`),
      locks: navigator.locks,
      win: this.win,
      doc: this.visibility,
      location: this.location,
      history: {
        replaceState: (_d, _u, url) => {
          if (this.location && url)
            this.location = {
              href: url,
              hash: url.includes("#") ? url.slice(url.indexOf("#")) : "",
            };
        },
      },
      defaultBackend: async () => null,
    };
  }

  async open(
    config: Partial<BurrowConfig> = {},
    env = this.env(),
  ): Promise<Core> {
    const a = (await createBurrow(
      {
        app: "test",
        backend: this.backend,
        syncIntervalMs: 0,
        debounceMs: 10,
        ...config,
      },
      env,
    )) as Core;
    if (!this.world.areas.includes(a)) this.world.areas.push(a);
    return a;
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

/** Resolve once the area has no running or scheduled sync work. */
export async function settle(a: Core): Promise<void> {
  await a.syncNow().catch(() => {});
}
