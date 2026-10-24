// burrow-storage/offline: a plaintext copy of one app's data on this device, in
// front of the core (D-57). Reads and writes go to the store first and answer
// from the copy when it cannot be reached; writes made meanwhile are kept
// (SYNC-9) and replayed when it can. The copy relies on the device for its
// protection: it is not encrypted, and it never holds the token or a key.
import { IdbCache } from "./cache/indexeddb.js";
import { MemoryCache } from "./cache/memory.js";
import type { AppMeta, Cache, Updated } from "./cache/types.js";
import {
  type Entry,
  type Pulled,
  type Remote,
  keyList,
  live,
  pick,
  prepareWrites,
  remoteOf,
  tombstones,
  versionOf,
} from "./core.js";
import { BurrowError, fromBackend } from "./errors.js";
import { BurrowEvent } from "./events.js";
import { compare } from "./sync/merge.js";
import type {
  BurrowStorage,
  ChangedEvent,
  GetKeys,
  OfflineStorage,
  Status,
  StatusEvent,
  StorageChanges,
} from "./types.js";

/**
 * Host services, injectable so tests can simulate several devices and tabs in
 * one process.
 */
export interface OfflineEnv {
  /** Namespace for lock names. */
  ns: string;
  openCache(app: string, identity: string): Promise<Cache>;
  channel(name: string): BroadcastChannel | null;
  locks: LockManager | null;
  /** Receives online/visibilitychange; null outside a browser. */
  win: EventTarget | null;
  doc: { visibilityState: DocumentVisibilityState } | null;
  /** False when the browser knows it has no network. */
  online(): boolean;
  /** How long a read or write waits for the store before answering locally. */
  waitMs: number;
}

const RENEW_MS = 30 * 24 * 60 * 60_000;
const HIDDEN_DETACH_MS = 5 * 60_000;
const RETRY_CAP_MS = 5 * 60_000;
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);

const sameVisible = (
  a: Entry | null | undefined,
  b: Entry | null | undefined,
) =>
  live(a)
    ? live(b) && JSON.stringify(a.value) === JSON.stringify(b.value)
    : !live(b);

/** API-5: the visible changes of a cache update, in chrome.storage's shape. */
function changesOf(written: Updated): StorageChanges {
  const ch: StorageChanges = {};
  for (const [k, [before, after]] of written) {
    if (sameVisible(before, after)) continue;
    const c: { oldValue?: unknown; newValue?: unknown } = {};
    if (live(before)) c.oldValue = before.value;
    if (live(after)) c.newValue = after.value;
    ch[k] = c;
  }
  return ch;
}

type Message =
  | { t: "changed"; changes: StorageChanges; source: "local" | "remote" }
  | { t: "forget" };

const wrapped = new WeakSet<Remote>();

class Offline implements OfflineStorage {
  readonly onChanged = new BurrowEvent<ChangedEvent>("changed");
  readonly onStatus = new BurrowEvent<StatusEvent>("status");

  readonly #store: BurrowStorage;
  readonly #remote: Remote;
  readonly #env: OfflineEnv;
  readonly #cache: Cache;
  #meta: AppMeta = {};
  #status: Status = "idle";
  #error: BurrowError | undefined;
  #paused = false;
  #closed = false;
  // Keys this tab knows to be unsynced; a full replay rescans the copy.
  #dirtyKeys = new Set<string>();
  // Keys with a set()/remove() on its way to the store: a pull must not
  // replace them before they are stamped above the remote version.
  #fresh = new Map<string, number>();
  #renewDue = false;

  #syncing: Promise<void> | null = null;
  #rerun = false;
  #wantPull = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelay = 0;
  #hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  #unwatch: (() => void) | null = null;
  #channel: BroadcastChannel | null = null;
  #listeners: [string, EventListener][] = [];

  private constructor(
    store: BurrowStorage,
    remote: Remote,
    env: OfflineEnv,
    cache: Cache,
  ) {
    this.#store = store;
    this.#remote = remote;
    this.#env = env;
    this.#cache = cache;
  }

  /**
   * Open the local copy for the store's token. Reads the device only, so it
   * resolves offline (D-57).
   */
  static async create(store: BurrowStorage, env: OfflineEnv): Promise<Offline> {
    const remote = remoteOf(store);
    if (!remote) throw new TypeError("offline() takes a store from burrow()");
    if (remote.closed) throw new BurrowError("closed", "this store was closed");
    if (wrapped.has(remote))
      throw new TypeError("this store already has an offline copy");
    wrapped.add(remote);
    let cache: Cache;
    let degraded = false;
    try {
      cache = await env.openCache(remote.app, remote.identity);
    } catch {
      cache = new MemoryCache(remote.app, remote.identity); // SYNC-4
      degraded = true;
    }
    const o = new Offline(store, remote, env, cache);
    o.#meta = await cache.getMeta();
    for (const [k, e] of await cache.loadItems())
      if (e.dirty) o.#dirtyKeys.add(k);
    if (degraded || !env.online()) o.#setStatus("offline");
    o.#start();
    return o;
  }

  // ---------------------------------------------------- lifecycle

  #start(): void {
    const win = this.#env.win;
    const on = (type: string, fn: EventListener) => {
      if (!win) return;
      win.addEventListener(type, fn);
      this.#listeners.push([type, fn]);
    };
    on("online", () => this.#kick(true));
    on("offline", () => {
      if (!this.#paused) this.#setStatus("offline");
    });
    on("visibilitychange", () =>
      this.#visible() ? this.#show() : this.#hide(),
    );
    this.#channel = this.#env.channel(
      `burrow:${this.#remote.app}:${this.#remote.identity}`,
    );
    if (this.#channel)
      this.#channel.onmessage = (e) => this.#onMessage(e.data as Message);
    this.#watch();
    this.#noteUse();
    if (this.#dirtyKeys.size) this.#kick(false);
  }

  #visible(): boolean {
    return (this.#env.doc?.visibilityState ?? "visible") === "visible";
  }

  #show(): void {
    clearTimeout(this.#hiddenTimer);
    this.#watch();
    this.#kick(true); // SYNC-6: refresh when the page becomes visible
  }

  #hide(): void {
    clearTimeout(this.#hiddenTimer);
    // FS-9: drop the live listener after five hidden minutes.
    this.#hiddenTimer = setTimeout(() => {
      this.#unwatch?.();
      this.#unwatch = null;
    }, HIDDEN_DETACH_MS);
  }

  #watch(): void {
    if (this.#unwatch || this.#paused || this.#closed) return;
    this.#unwatch = this.#remote.watch(
      () => this.#kick(true),
      () => this.#failed(new BurrowError("expired")),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#hiddenTimer);
    this.#unwatch?.();
    this.#unwatch = null;
    for (const [type, fn] of this.#listeners)
      this.#env.win?.removeEventListener(type, fn);
    this.#listeners = [];
    this.#channel?.close();
    this.#channel = null;
    this.#cache.close();
    this.#store.close();
  }

  async forget(options: { discardLocal?: boolean } = {}): Promise<void> {
    this.#alive();
    if (!options?.discardLocal) {
      // API-8: try to keep unsynced writes before refusing to drop them.
      if (await this.#hasDirty()) await this.#sync(false);
      if (await this.#hasDirty()) throw new BurrowError("would-orphan");
    }
    this.#post({ t: "forget" });
    const cache = this.#cache;
    this.close();
    await cache.destroy();
  }

  #alive(): void {
    if (this.#remote.closed) this.close();
    if (this.#closed) throw new BurrowError("closed", "this store was closed");
  }

  async #hasDirty(): Promise<boolean> {
    return [...(await this.#cache.loadItems()).values()].some((e) => e.dirty);
  }

  // ---------------------------------------------------- status

  get status(): Status {
    return this.#status;
  }

  #setStatus(s: Status, error?: BurrowError): void {
    if (s === this.#status && error === this.#error) return;
    this.#status = s;
    this.#error = error;
    this.onStatus.emit(error ? { status: s, error } : { status: s }); // ERR-2
  }

  /** Whether a read or write should try the store before the local copy. */
  #reachable(): boolean {
    return (
      !this.#paused && this.#retryTimer === undefined && this.#env.online()
    );
  }

  /**
   * Network first: wait for the store up to `waitMs`, then answer locally. The
   * remote work carries on and lands in the local copy when it finishes.
   */
  async #attempt(fn: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = fn().then(
      () => this.#ok(),
      (e) => this.#failed(e),
    );
    await Promise.race([
      work,
      new Promise<void>((r) => {
        timer = setTimeout(r, this.#env.waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  #ok(): void {
    this.#retryDelay = 0;
    if (!this.#paused && this.#status !== "syncing") this.#setStatus("idle");
    if (this.#dirtyKeys.size || this.#renewDue) this.#kick(false);
  }

  #failed(e: unknown): void {
    if (this.#closed) return;
    // A pending request can fail after a subscription already observed expiry.
    if (this.#paused && this.#error?.code === "expired") return;
    const err = fromBackend(e);
    if (err.code === "closed") return this.close();
    if (err.code === "decrypt-failed" || err.code === "expired") {
      // ENC-6, D-48: stop remote work; the local copy and unsynced writes stay.
      this.#paused = true;
      this.#unwatch?.();
      this.#unwatch = null;
      this.#setStatus("error", err);
    } else if (err.code === "conflict" || err.code === "item-too-large") {
      // retried on the next write or sync; items stay dirty
      this.#setStatus("error", err);
    } else {
      // SYNC-9: network/quota -> exponential backoff, capped; dirty items are
      // never dropped.
      this.#setStatus("offline", err);
      this.#retryDelay = Math.min(
        RETRY_CAP_MS,
        this.#retryDelay ? this.#retryDelay * 2 : 2_000,
      );
      clearTimeout(this.#retryTimer);
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = undefined;
        void this.#sync(true);
      }, jitter(this.#retryDelay));
    }
  }

  // ---------------------------------------------------- the public API

  async get(keys?: GetKeys): Promise<Record<string, unknown>> {
    this.#alive();
    this.#noteUse();
    const list = keyList(keys);
    if (this.#reachable()) await this.#attempt(() => this.#pull(list));
    return pick(
      keys,
      list ? await this.#cache.getItems(list) : await this.#cache.loadItems(),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.#alive();
    this.#noteUse();
    const local = await this.#cache.getItems(
      items && typeof items === "object" ? Object.keys(items) : [],
    );
    const entries = await prepareWrites(
      items,
      (k) => local.get(k)?.ts,
      this.#meta.maxRemoteTs,
    );
    await this.#writeFresh(entries);
  }

  async remove(keys: string | string[]): Promise<void> {
    this.#alive();
    this.#noteUse();
    const list = typeof keys === "string" ? [keys] : keys;
    const local = await this.#cache.getItems(list);
    const all = tombstones(list, (k) => local.get(k), this.#meta.maxRemoteTs);
    // A delete of a key this copy does not show is a no-op offline, as in
    // chrome.storage; online it still reaches the store.
    const shown = new Map([...all].filter(([k]) => live(local.get(k))));
    const elsewhere = new Map([...all].filter(([k]) => !shown.has(k)));
    await this.#writeFresh(shown, elsewhere);
  }

  async clear(): Promise<void> {
    this.#alive();
    this.#noteUse();
    // Learn the keys only the store has, when it answers in time.
    if (this.#reachable()) await this.#attempt(() => this.#pull(null));
    const all = await this.#cache.loadItems();
    await this.remove([...all].filter(([, e]) => live(e)).map(([k]) => k));
  }

  async syncNow(): Promise<void> {
    this.#alive();
    this.#noteUse();
    await this.#sync(true);
    if ((this.#status === "error" || this.#status === "offline") && this.#error)
      throw this.#error;
  }

  // ---------------------------------------------------- local copy

  #emit(changes: StorageChanges, source: "local" | "remote"): void {
    if (!Object.keys(changes).length) return;
    this.onChanged.emit({ changes, source });
    this.#post({ t: "changed", changes, source }); // SYNC-14
  }

  #post(msg: Message): void {
    try {
      this.#channel?.postMessage(msg);
    } catch {
      /* closed */
    }
  }

  #onMessage(msg: Message): void {
    if (this.#closed) return;
    if (msg?.t === "changed")
      this.onChanged.emit({ changes: msg.changes, source: msg.source });
    else if (msg?.t === "forget") this.close(); // another tab forgot this copy
  }

  /**
   * API-6: store a write durably as dirty, then try the store as a fresh write
   * (stamped above what it holds) for up to `waitMs`.
   */
  async #writeFresh(
    entries: Map<string, Entry>,
    remoteOnly = new Map<string, Entry>(),
  ): Promise<void> {
    const keys = [...entries.keys(), ...remoteOnly.keys()];
    if (!keys.length) return;
    for (const k of keys) this.#fresh.set(k, (this.#fresh.get(k) ?? 0) + 1);
    const release = () => {
      for (const k of keys) {
        const n = this.#fresh.get(k)! - 1;
        if (n) this.#fresh.set(k, n);
        else this.#fresh.delete(k);
      }
    };
    try {
      await this.#writeLocal(entries);
    } catch (e) {
      release();
      throw e;
    }
    if (!this.#reachable()) return release();
    await this.#attempt(() =>
      this.#replay(keys, true, remoteOnly).finally(release),
    );
  }

  async #writeLocal(entries: Map<string, Entry>): Promise<void> {
    if (!entries.size) return;
    const written = await this.#cache.updateItems(
      [...entries.keys()],
      (k, cur) => {
        const { rev: _r, ...e } = entries.get(k)!;
        return {
          ...e,
          // Another tab may have written this key since it was stamped.
          ts: Math.max(e.ts, (cur?.ts ?? -1) + 1),
          dirty: true,
          ...(cur?.rev === undefined ? {} : { rev: cur.rev }),
        };
      },
    );
    for (const k of written.keys()) this.#dirtyKeys.add(k);
    this.#emit(changesOf(written), "local");
  }

  async #lock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = this.#env.locks;
    const name = `burrow:${this.#env.ns}:${this.#remote.app}:${this.#remote.identity}:sync`;
    return locks ? (locks.request(name, fn) as Promise<T>) : fn();
  }

  async #setMeta(patch: Partial<AppMeta>): Promise<void> {
    this.#meta = { ...this.#meta, ...patch };
    await this.#cache.setMeta(patch);
  }

  /**
   * Merge what a pull found into the local copy. A dirty entry survives unless
   * the remote version beats it (SYNC-10); clean entries no longer listed are
   * pruned.
   */
  async #pull(list: string[] | null): Promise<void> {
    const local = list
      ? await this.#cache.getItems(list)
      : await this.#cache.loadItems();
    const pulled: Pulled = await this.#remote.pull(list, (k) => {
      const e = local.get(k);
      return e && versionOf(e);
    });
    let maxTs = this.#meta.maxRemoteTs ?? 0;
    for (const v of Object.values(pulled.listed ?? {}))
      maxTs = Math.max(maxTs, v.ts);
    for (const e of pulled.items.values()) if (e) maxTs = Math.max(maxTs, e.ts);
    const keys = list ?? [
      ...new Set([...local.keys(), ...pulled.items.keys()]),
    ];
    const written = await this.#cache.updateItems(keys, (k, cur) => {
      const r = pulled.items.get(k);
      if (r === undefined)
        return pulled.listed && !(k in pulled.listed) && cur && !cur.dirty
          ? null
          : undefined;
      // No document: keep what this device has; it may be the only copy.
      if (r === null || (cur?.dirty && this.#fresh.has(k))) return undefined;
      if (!cur || compare(versionOf(r), versionOf(cur)) > 0) return r;
      if (r.rev !== undefined && (cur.rev ?? -1) < r.rev)
        return { ...cur, rev: r.rev };
      return undefined;
    });
    for (const [k, [, after]] of written)
      if (!after?.dirty) this.#dirtyKeys.delete(k);
    await this.#setMeta({ maxRemoteTs: maxTs, lastSyncAt: Date.now() });
    this.#emit(changesOf(written), "remote");
  }

  /**
   * Push unsynced writes: the named keys as fresh writes (`restamp`), or every
   * dirty entry with its own version. `remoteOnly` adds deletes that are not
   * kept locally. Clears `dirty` only where nothing newer was written
   * meanwhile (D-20).
   */
  async #replay(
    keys: string[] | null,
    restamp: boolean,
    remoteOnly = new Map<string, Entry>(),
  ): Promise<void> {
    await this.#lock(async () => {
      const found = keys
        ? await this.#cache.getItems(keys)
        : await this.#cache.loadItems();
      const dirty = new Map([...found].filter(([, e]) => e.dirty));
      if (!keys) this.#dirtyKeys = new Set(dirty.keys());
      const sent = new Map(
        [...dirty].map(([k, { dirty: _d, ...e }]) => [k, e as Entry]),
      );
      for (const [k, e] of remoteOnly) if (!sent.has(k)) sent.set(k, e);
      if (!sent.size) return;
      const results = await this.#remote.push(sent, {
        fresh: restamp ? new Set(sent.keys()) : undefined,
        // A delete queued here must reach the store even where it has no
        // document, so an older queued write elsewhere cannot revive the key.
        ifPresent: new Set([...remoteOnly.keys()].filter((k) => !dirty.has(k))),
      });
      const written = await this.#cache.updateItems(
        [...sent.keys()],
        (k, cur) => {
          const s = sent.get(k)!;
          const r = results.get(k);
          if (r === undefined) return undefined;
          if (
            cur?.dirty &&
            cur.ts === s.ts &&
            !!cur.deleted === !!s.deleted &&
            cur.h === s.h
          )
            return r; // this write is in the store now
          if (cur?.dirty)
            // a newer local write arrived meanwhile: keep it, learn the rev
            return r?.rev !== undefined && (cur.rev ?? -1) < r.rev
              ? { ...cur, rev: r.rev }
              : undefined;
          // a delete of a key this copy did not show
          return cur && r && compare(versionOf(r), versionOf(cur)) > 0
            ? r
            : undefined;
        },
      );
      for (const [k, [, after]] of written)
        if (!after?.dirty) this.#dirtyKeys.delete(k);
      let maxTs = this.#meta.maxRemoteTs ?? 0;
      for (const r of results.values()) if (r) maxTs = Math.max(maxTs, r.ts);
      await this.#setMeta({ maxRemoteTs: maxTs, lastSyncAt: Date.now() });
      this.#emit(changesOf(written), "remote");
    });
  }

  /**
   * D-48: client use renews content once a month per device. Tabs share the
   * deadline; a failed renewal records nothing.
   */
  #noteUse(): void {
    if (this.#renewDue || Date.now() < (this.#meta.renewAt ?? 0)) return;
    this.#renewDue = true;
    if (this.#reachable()) queueMicrotask(() => this.#kick(false));
  }

  async #renew(): Promise<void> {
    await this.#lock(async () => {
      this.#meta = { ...this.#meta, ...(await this.#cache.getMeta()) };
      if (Date.now() < (this.#meta.renewAt ?? 0)) {
        this.#renewDue = false; // another tab renewed
        return;
      }
      const results = await this.#remote.renew(await this.#cache.loadItems());
      const written = await this.#cache.updateItems(
        [...results.keys()],
        (_k, cur) => {
          const r = results.get(_k);
          if (!r) return undefined;
          if (
            !cur ||
            (!cur.dirty && compare(versionOf(r), versionOf(cur)) >= 0)
          )
            return r;
          if (r.rev !== undefined && (cur.rev ?? -1) < r.rev)
            return { ...cur, rev: r.rev };
          return undefined;
        },
      );
      await this.#setMeta({
        renewAt: Date.now() + RENEW_MS - Math.random() * 24 * 60 * 60_000,
      });
      this.#renewDue = false;
      this.#emit(changesOf(written), "remote");
    });
  }

  /** Start a background sync unless remote work is paused or offline. */
  #kick(pull: boolean): void {
    if (this.#paused || this.#closed || !this.#env.online()) return;
    void this.#sync(pull);
  }

  /**
   * One background sync: replay unsynced writes, renew when due, and (`pull`)
   * refresh the whole local copy. Coalesces callers; never rejects.
   */
  #sync(pull: boolean): Promise<void> {
    if (this.#paused || this.#closed) return Promise.resolve();
    this.#wantPull ||= pull;
    if (this.#syncing) {
      this.#rerun = true;
      return this.#syncing;
    }
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#syncing = (async () => {
      do {
        this.#rerun = false;
        const withPull = this.#wantPull;
        this.#wantPull = false;
        this.#setStatus("syncing");
        try {
          await this.#replay(null, false);
          if (this.#renewDue) await this.#renew();
          if (withPull) await this.#pull(null);
          this.#retryDelay = 0;
          this.#setStatus("idle");
        } catch (e) {
          this.#failed(e);
          break;
        }
      } while (this.#rerun && !this.#closed && !this.#paused);
    })().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }
}

/** @internal Wrap a store against an explicit environment (tests). */
export function createOffline(
  store: BurrowStorage,
  env: OfflineEnv,
): Promise<OfflineStorage> {
  return Offline.create(store, env);
}

/** The host page's services. */
function browserEnv(): OfflineEnv {
  const g = globalThis as typeof globalThis & {
    window?: Window;
    document?: Document;
  };
  return {
    ns: "page",
    openCache: (app, identity) => IdbCache.open(app, identity),
    channel: (name) =>
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(name)
        : null,
    locks: g.navigator?.locks ?? null,
    win: g.window ?? null,
    doc: g.document ?? null,
    online: () => g.navigator?.onLine !== false,
    waitMs: 3_000,
  };
}

let pageEnv: OfflineEnv | undefined;

/**
 * Keep a plaintext copy of the store's data on this device, so reads and
 * writes keep working offline. Takes ownership of `store`: closing the result
 * closes it. Resolves from the device alone, with no network call.
 */
export function offline(store: BurrowStorage): Promise<OfflineStorage> {
  return createOffline(store, (pageEnv ??= browserEnv()));
}
