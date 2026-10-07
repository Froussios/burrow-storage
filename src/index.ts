// Burrow: persistent, cross-device, per-user storage for static sites. No
// login, no backend.
import { IdbCache } from "./cache/indexeddb.js";
import { MemoryCache } from "./cache/memory.js";
import { Core, type Env } from "./core.js";
import { passkey } from "./providers/passkey.js";
import { syncCode } from "./providers/synccode.js";
import type { Backend, BurrowArea, BurrowConfig } from "./types.js";

export { MemoryBackend } from "./backends/memory.js";
export type { MemoryBackendOptions } from "./backends/memory.js";
export { BurrowError, BackendError } from "./errors.js";
export type { BurrowErrorCode, BackendErrorCode } from "./errors.js";
export { BurrowEvent } from "./events.js";
export { passkey } from "./providers/passkey.js";
export type { PasskeyOptions } from "./providers/passkey.js";
export { syncCode } from "./providers/synccode.js";
export type * from "./types.js";

/**
 * FS-3: the Firestore config from <meta name="burrow-firestore"> or
 * window.BURROW.firestore.
 */
export function readFirestoreConfig(): {
  apiKey: string;
  projectId: string;
  appId: string;
} | null {
  const meta = globalThis.document
    ?.querySelector?.('meta[name="burrow-firestore"]')
    ?.getAttribute("content");
  if (meta) {
    try {
      return JSON.parse(meta);
    } catch {
      console.warn('[burrow] <meta name="burrow-firestore"> is not valid JSON');
    }
  }
  return (
    (
      globalThis as {
        BURROW?: {
          firestore?: { apiKey: string; projectId: string; appId: string };
        };
      }
    ).BURROW?.firestore ?? null
  );
}

let warnedNoBackend = false;

async function defaultBackend(): Promise<Backend | null> {
  const cfg = readFirestoreConfig();
  if (!cfg) {
    // Principle 7: keep working locally when sync is unavailable.
    if (!warnedNoBackend) {
      warnedNoBackend = true;
      console.warn("[burrow] no backend configured; data stays on this device");
    }
    return null;
  }
  const { FirestoreBackend } = await import("./backends/firestore.js");
  return new FirestoreBackend(cfg);
}

/** The host page's services. */
export function browserEnv(ns = "page"): Env {
  const g = globalThis as typeof globalThis & {
    window?: Window;
    document?: Document;
  };
  return {
    ns,
    openCache: (app, kind) =>
      kind === "memory"
        ? Promise.resolve(new MemoryCache(app))
        : IdbCache.open(app),
    channel: (name) =>
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(name)
        : null,
    locks: g.navigator?.locks ?? null,
    win: g.window ?? null,
    doc: g.document ?? null,
    defaultBackend,
  };
}

// API-2: one instance per (page, app). Keyed by environment so tests can model
// devices and tabs.
const instances = new WeakMap<Env, Map<string, Promise<Core>>>();

/**
 * @internal Create an area against an explicit environment (tests simulate
 *   devices with this).
 */
export function createBurrow(
  config: BurrowConfig,
  env: Env,
): Promise<BurrowArea> {
  let apps = instances.get(env);
  if (!apps) instances.set(env, (apps = new Map()));
  const app = config?.app;
  let p = apps.get(app);
  if (!p) {
    p = Core.create(config, env, [passkey(), syncCode()], () =>
      apps.delete(app),
    );
    apps.set(app, p);
    p.catch(() => apps.delete(app));
  }
  return p;
}

let pageEnv: Env | undefined;

/**
 * Open the store for one app. Resolves from the local cache with no user
 * interaction (API-1); repeated calls with the same app return the same
 * instance (API-2).
 */
export function burrow(config: BurrowConfig): Promise<BurrowArea> {
  return createBurrow(config, (pageEnv ??= browserEnv()));
}
