// Burrow core: local cache (source of truth for the UI), codec and sync engine (§4, §8).
import { hex, sha256, utf8 } from "./bytes.js";
import { MemoryCache } from "./cache/memory.js";
import type { AppMeta, Cache, CachedItem } from "./cache/types.js";
import { type AppKeys, deriveAppKeys, docId } from "./codec/derive.js";
import {
  type DocCipher,
  HARD_MAX_PLAINTEXT,
  assertJson,
  open,
  seal,
} from "./codec/envelope.js";
import { decodeSyncCode, encodeSyncCode } from "./codec/synccode.js";
import { BackendError, BurrowError, fromBackend } from "./errors.js";
import { BurrowEvent } from "./events.js";
import { createFacade } from "./facade.js";
import { SecretHolder } from "./secret.js";
import {
  type Versioned,
  compare,
  entryOf,
  mergeDirectories,
  nextTs,
  valueHash,
} from "./sync/merge.js";
import type {
  Backend,
  BurrowArea,
  BurrowConfig,
  ChangedEvent,
  Envelope,
  GetKeys,
  Inspection,
  Item,
  KeyProvider,
  Manifest,
  Protection,
  ProviderStore,
  Status,
  TokenInfo,
  TokenSource,
  StatusEvent,
  StorageChanges,
} from "./types.js";

/** Host services, injectable so tests can simulate several devices in one process. */
export interface Env {
  /** Namespace for lock and channel names. */
  ns: string;
  openCache(app: string, kind: "indexeddb" | "memory"): Promise<Cache>;
  channel(name: string): BroadcastChannel | null;
  locks: LockManager | null;
  /** Receives visibilitychange/pagehide; null outside a browser. */
  win: EventTarget | null;
  doc: { visibilityState: DocumentVisibilityState } | null;
  location: { hash: string; href: string } | null;
  history: {
    replaceState(data: unknown, unused: string, url?: string): void;
  } | null;
  defaultBackend(): Promise<Backend | null>;
}

const APP_RE = /^[a-z0-9-]{1,64}$/;
const CONFLICT_BACKOFF = [200, 800, 3000];
const HIDDEN_DETACH_MS = 5 * 60_000;
/** SYNC-6: a focus pulls only if no pass started this recently (focus fires on every window switch). */
const FOCUS_MIN_MS = 5_000;
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Entry = CachedItem;
const live = (e: Entry | undefined): e is Entry => !!e && !e.deleted;
const sameVisible = (a: Entry | undefined, b: Entry | undefined) =>
  live(a)
    ? live(b) && JSON.stringify(a.value) === JSON.stringify(b.value)
    : !live(b);
const versionOf = (e: Entry): Versioned =>
  e.deleted ? { ts: e.ts, deleted: true } : { ts: e.ts, h: e.h ?? "" };

function addChange(
  ch: StorageChanges,
  key: string,
  before: Entry | undefined,
  after: Entry | undefined,
): void {
  if (sameVisible(before, after)) return;
  const c: { oldValue?: unknown; newValue?: unknown } = ch[key] ?? {};
  if (!(key in ch) && live(before)) c.oldValue = before.value;
  if (live(after)) c.newValue = after.value;
  else delete c.newValue;
  ch[key] = c;
  if (!("oldValue" in c) && !("newValue" in c)) delete ch[key];
}

const protectionFor = (providerId: string): Protection =>
  providerId === "sync-code" ? "code" : providerId;

let warnedNoAuth = false;

export class Core implements BurrowArea {
  readonly app: string;
  readonly onChanged = new BurrowEvent<ChangedEvent>("changed");
  readonly onStatus = new BurrowEvent<StatusEvent>("status");
  readonly onUnprotected = new BurrowEvent<void>("unprotected");
  readonly onToken = new BurrowEvent<TokenInfo>("token");
  readonly storage: Storage;

  readonly #env: Env;
  readonly #backend: Backend | null;
  readonly #providers: KeyProvider[];
  readonly #remember: boolean;
  readonly #interval: number;
  readonly #debounce: number;
  readonly #maxItem: number;
  readonly #debug: boolean;
  readonly #onClose: () => void;

  #cache!: Cache;
  #secret: SecretHolder | null = null;
  #keys: AppKeys | null = null;
  #mirror = new Map<string, Entry>();
  #meta: AppMeta = {};
  #protection: Protection = "none";
  #token: TokenInfo = { source: "generated", remembered: false, since: null };
  #status: Status = "idle";
  #error: BurrowError | undefined;
  #paused = false;
  #closed = false;

  // Facade writes are visible at once and persisted in the background (API-11). A key is
  // "unsettled" from the local write until its cache write completes; reloads skip it.
  #pending = new Set<string>();
  #inFlight = new Map<string, number>();
  // Local write sequence: a read of the cache that began before a key's last local write must not
  // overwrite that key in the mirror.
  #writeSeq = 0;
  #lastWrite = new Map<string, number>();
  #persisting: Promise<void> = Promise.resolve();
  #flushScheduled = false;
  #queuedChanges: StorageChanges | null = null;

  #running: Promise<void> | null = null;
  #rerun = false;
  #passStartedAt = 0;
  #suppressEmit = false;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelay = 0;
  #hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | null = null;
  #channel: BroadcastChannel | null = null;
  #listeners: [string, EventListener][] = [];

  private constructor(
    config: BurrowConfig,
    env: Env,
    backend: Backend | null,
    onClose: () => void,
  ) {
    this.app = config.app;
    this.#env = env;
    this.#backend = backend;
    const kp = config.keyProvider;
    this.#providers = kp ? (Array.isArray(kp) ? kp : [kp]) : [];
    this.#remember = config.rememberDevice !== false;
    this.#interval = config.syncIntervalMs ?? 30_000;
    this.#debounce = config.debounceMs ?? 1_500;
    this.#maxItem = Math.min(
      config.maxItemBytes ?? 200_000,
      HARD_MAX_PLAINTEXT,
    );
    this.#debug = !!config.debug;
    this.#onClose = onClose;
    this.storage = createFacade(this);
  }

  /** API-1: resolves with a usable secret and a loaded mirror, with no user interaction. */
  static async create(
    config: BurrowConfig,
    env: Env,
    providers: KeyProvider[],
    onClose: () => void,
  ): Promise<Core> {
    if (!APP_RE.test(config.app ?? ""))
      throw new TypeError("app must match /^[a-z0-9-]{1,64}$/");
    const backend = config.backend ?? (await env.defaultBackend());
    const core = new Core(
      { ...config, keyProvider: config.keyProvider ?? providers },
      env,
      backend,
      onClose,
    );
    await core.#init(config);
    return core;
  }

  async #init(config: BurrowConfig): Promise<void> {
    const kind = config.cache ?? (this.#remember ? "indexeddb" : "memory");
    let degraded = false;
    try {
      this.#cache = await this.#env.openCache(this.app, kind);
    } catch {
      this.#cache = new MemoryCache(this.app); // SYNC-4
      degraded = true;
    }
    await this.#lock("secret", async () => {
      let s = this.#remember ? await SecretHolder.load(this.#cache) : null;
      if (s) {
        const d = await this.#cache.getDevice();
        this.#token = {
          source: d.tokenSource ?? "unknown",
          remembered: true,
          since: d.tokenSince ?? null,
        };
      } else {
        s = await SecretHolder.generate(); // KP-1
        this.#token = {
          source: "generated",
          remembered: false,
          since: Date.now(),
        };
        if (this.#remember) {
          await s.persist(this.#cache);
          await this.#cache.setDevice({
            protection: undefined,
            tokenSource: "generated",
            tokenSince: this.#token.since!,
          });
        }
      }
      this.#secret = s;
    });
    await this.#adoptIdentity();
    if (degraded) this.#setStatus("offline");
    if (
      this.#backend &&
      !this.#backend.capabilities.writeAuth &&
      !warnedNoAuth
    ) {
      warnedNoAuth = true; // ENC-9
      console.warn(
        `[burrow] backend "${this.#backend.id}" cannot enforce the write-token chain; anyone who learns an id can overwrite it.`,
      );
    }
    this.#start();
    await this.#readFragment();
  }

  /** Derive keys for the held secret, and make sure the cache belongs to it (docs/decisions.md D-8). */
  async #adoptIdentity(): Promise<void> {
    this.#keys = await this.#secret!.use((s) => deriveAppKeys(s, this.app));
    const owner = hex(await sha256(utf8("owner:" + this.#keys.base))).slice(
      0,
      16,
    );
    let meta = await this.#cache.getMeta();
    if (meta.owner !== owner) {
      await this.#cache.clearItems();
      meta = {
        owner,
        manifestRev: null,
        maxRemoteTs: 0,
        lastSyncAt: null,
        unprotectedFired: false,
      };
      await this.#cache.setMeta(meta);
    }
    this.#meta = meta;
    this.#mirror = await this.#cache.loadItems();
    this.#protection =
      (await this.#cache.getDevice()).protection ??
      (this.#remember ? "none" : this.#protection);
  }

  // ---------------------------------------------------------------- lifecycle

  #start(): void {
    const on = (
      target: EventTarget | null,
      type: string,
      fn: EventListener,
    ) => {
      if (!target) return;
      target.addEventListener(type, fn);
      this.#listeners.push([type, fn]);
    };
    const win = this.#env.win;
    // API-11, SYNC-5: flush facade writes and push when the page is hidden or unloaded.
    on(win, "pagehide", () => void this.#hide());
    on(win, "visibilitychange", () =>
      this.#visible() ? this.#show() : void this.#hide(),
    );
    // SYNC-6: pull on focus too, unless a pass started moments ago (e.g. by visibilitychange).
    on(win, "focus", () => {
      if (this.#visible() && Date.now() - this.#passStartedAt >= FOCUS_MIN_MS)
        void this.#sync();
    });
    this.#channel = this.#env.channel(`burrow:${this.app}`);
    if (this.#channel)
      this.#channel.onmessage = (e) => void this.#onMessage(e.data);
    if (this.#interval > 0)
      this.#pollTimer = setInterval(() => {
        if (this.#visible()) void this.#sync();
      }, this.#interval);
    this.#subscribe();
    void this.#sync();
    setTimeout(() => void this.#checkUnprotected(), 0);
  }

  #visible(): boolean {
    return (this.#env.doc?.visibilityState ?? "visible") === "visible";
  }

  #show(): void {
    clearTimeout(this.#hiddenTimer);
    this.#subscribe();
    void this.#sync(); // SYNC-6: pull on visibility -> visible
  }

  async #hide(): Promise<void> {
    clearTimeout(this.#hiddenTimer);
    // FS-9: drop the live listener after five hidden minutes.
    this.#hiddenTimer = setTimeout(() => {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
    }, HIDDEN_DETACH_MS);
    await this.#flush();
    if ([...this.#mirror.values()].some((e) => e.dirty)) await this.#sync(true);
  }

  #subscribe(): void {
    const b = this.#backend;
    if (
      this.#unsubscribe ||
      !b?.capabilities.subscribe ||
      !b.subscribe ||
      !this.#keys
    )
      return;
    // SYNC-6: subscribe to the manifest only; fetch changed items on each notification.
    this.#unsubscribe = b.subscribe(this.#keys.base, (env) => {
      if (env.rev !== this.#meta.manifestRev) void this.#sync();
    });
  }

  /** Stop timers and listeners. The instance is unusable afterwards. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#pushTimer);
    clearInterval(this.#pollTimer);
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#hiddenTimer);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const [type, fn] of this.#listeners)
      this.#env.win?.removeEventListener(type, fn);
    this.#listeners = [];
    this.#channel?.close();
    this.#channel = null;
    this.#onClose();
  }

  #alive(): void {
    if (this.#closed)
      throw new BurrowError(
        "no-provider",
        "this device was unlinked; call burrow() again",
      );
  }

  // ---------------------------------------------------------------- status, logging

  get status(): Status {
    return this.#status;
  }
  get protection(): Protection {
    return this.#protection;
  }
  get token(): TokenInfo {
    return { ...this.#token };
  }

  #setStatus(s: Status, error?: BurrowError): void {
    if (s === this.#status && error === this.#error) return;
    this.#status = s;
    this.#error = error;
    this.onStatus.emit(error ? { status: s, error } : { status: s }); // ERR-2
  }

  /** ERR-3: one line per sync event. Never ids, tokens, keys or values. */
  #log(
    event: string,
    data: Record<string, number | string | boolean | null>,
  ): void {
    if (this.#debug) console.debug(`[burrow:${this.app}] ${event}`, data);
  }

  inspect(): Inspection {
    let dirty = 0;
    for (const e of this.#mirror.values()) if (e.dirty) dirty++;
    return {
      status: this.#status,
      tokenSource: this.#token.source,
      protection: this.#protection,
      manifestRev: this.#meta.manifestRev ?? null,
      dirtyKeys: dirty,
      lastSyncAt: this.#meta.lastSyncAt ?? null,
      backend: this.#backend?.id ?? "none",
      provider:
        this.#protection === "none"
          ? null
          : this.#protection === "code"
            ? "sync-code"
            : this.#protection,
    };
  }

  // ---------------------------------------------------------------- local reads and writes

  #pick(keys: GetKeys): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const one = (k: string, dflt?: { v: unknown }) => {
      const e = this.#mirror.get(k);
      if (live(e)) out[k] = structuredClone(e.value);
      else if (dflt) out[k] = dflt.v;
    };
    if (keys === null || keys === undefined)
      for (const k of this.#mirror.keys()) one(k);
    else if (typeof keys === "string") one(keys);
    else if (Array.isArray(keys)) keys.forEach((k) => one(k));
    else for (const [k, v] of Object.entries(keys)) one(k, { v });
    return out;
  }

  async get(
    keys?: GetKeys,
    opts?: { fresh?: boolean },
  ): Promise<Record<string, unknown>> {
    this.#alive();
    if (opts?.fresh && this.#backend && !this.#paused) {
      try {
        if (keys === null || keys === undefined) await this.#sync();
        else
          await this.#fetchKeys(
            typeof keys === "string"
              ? [keys]
              : Array.isArray(keys)
                ? keys
                : Object.keys(keys),
          );
      } catch {
        /* SYNC-7 is best-effort; the cache answers */
      }
    }
    return this.#pick(keys);
  }

  #itemBytes(key: string, value: unknown, ts: number): number {
    return utf8(JSON.stringify({ v: 1, key, value, ts })).length;
  }

  /** Validate and stamp writes. Throws TypeError / item-too-large before anything is written (ERR-1). */
  #prepare(items: [string, unknown][]): Map<string, Entry> {
    const out = new Map<string, Entry>();
    const now = Date.now();
    for (const [k, value] of items) {
      if (typeof k !== "string") throw new TypeError("keys must be strings");
      if (value === undefined)
        throw new TypeError(`value for "${k}" is undefined`);
      assertJson(value, k);
      const ts = nextTs(now, this.#mirror.get(k)?.ts, this.#meta.maxRemoteTs);
      if (this.#itemBytes(k, value, ts) > this.#maxItem)
        throw new BurrowError(
          "item-too-large",
          `"${k}" is larger than ${this.#maxItem} bytes`,
        );
      out.set(k, { value: structuredClone(value), ts, dirty: true });
    }
    return out;
  }

  #tombstones(keys: string[]): Map<string, Entry> {
    const out = new Map<string, Entry>();
    const now = Date.now();
    for (const k of keys) {
      const cur = this.#mirror.get(k);
      if (!live(cur)) continue;
      out.set(k, {
        ts: nextTs(now, cur.ts, this.#meta.maxRemoteTs),
        deleted: true,
        dirty: true,
      });
    }
    return out;
  }

  /** Apply local writes to the mirror at once; persist now (await) or in the background (facade). */
  #applyLocal(
    updates: Map<string, Entry>,
    background: boolean,
  ): { changes: StorageChanges; persisted: Promise<void> } {
    const changes: StorageChanges = {};
    const keys: string[] = [];
    for (const [k, e] of updates) {
      const old = this.#mirror.get(k);
      // An unchanged value is still a new write: it must beat any concurrent write made elsewhere
      // in the meantime (last writer wins). Only the onChanged event is skipped, as chrome.storage does.
      if (old?.rev !== undefined) e.rev = old.rev;
      this.#mirror.set(k, e);
      this.#lastWrite.set(k, ++this.#writeSeq);
      addChange(changes, k, old, e);
      keys.push(k);
    }
    if (!keys.length) return { changes, persisted: Promise.resolve() };
    for (const k of keys) this.#pending.add(k);
    const persisted = background ? this.#scheduleFlush() : this.#flush();
    void persisted.then(
      () => {
        this.#broadcast({ t: "changed", keys, source: "local" });
        this.#schedulePush();
        void this.#checkUnprotected();
      },
      () => {},
    );
    return { changes, persisted };
  }

  #scheduleFlush(): Promise<void> {
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      queueMicrotask(() => {
        this.#flushScheduled = false;
        void this.#flush();
      });
    }
    return new Promise<void>((res) =>
      queueMicrotask(() => void this.#persisting.then(res, res)),
    );
  }

  /** Write every pending mirror entry to the cache. */
  #flush(): Promise<void> {
    const keys = [...this.#pending];
    this.#pending.clear();
    if (!keys.length) return this.#persisting;
    for (const k of keys)
      this.#inFlight.set(k, (this.#inFlight.get(k) ?? 0) + 1);
    const run = this.#persisting
      .then(() =>
        this.#cache.updateItems(keys, (k, cur) => {
          const e = this.#mirror.get(k);
          if (!e) return null;
          const rev = Math.max(cur?.rev ?? -1, e.rev ?? -1);
          return rev >= 0 ? { ...e, rev } : e;
        }),
      )
      .then(() => {})
      .finally(() => {
        for (const k of keys) {
          const n = this.#inFlight.get(k)! - 1;
          if (n) this.#inFlight.set(k, n);
          else this.#inFlight.delete(k);
        }
      });
    this.#persisting = run.catch((err) => {
      this.#log("persist-failed", { message: String(err) });
    });
    return run;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.#alive();
    if (!items || typeof items !== "object")
      throw new TypeError("set() takes an object of key/value pairs");
    const { changes, persisted } = this.#applyLocal(
      this.#prepare(Object.entries(items)),
      false,
    );
    await persisted; // API-6: resolves once durable locally
    this.#emitChanges(changes, "local");
  }

  async remove(keys: string | string[]): Promise<void> {
    this.#alive();
    const { changes, persisted } = this.#applyLocal(
      this.#tombstones(typeof keys === "string" ? [keys] : keys),
      false,
    );
    await persisted;
    this.#emitChanges(changes, "local");
  }

  async clear(): Promise<void> {
    this.#alive();
    await this.remove([...this.#mirror.keys()]); // SYNC-12
  }

  async getBytesInUse(keys?: null | string | string[]): Promise<number> {
    let n = 0;
    for (const [k, v] of Object.entries(this.#pick(keys)))
      n += utf8(k).length + utf8(JSON.stringify(v)).length;
    return n;
  }

  // Synchronous access for the Storage facade (API-9..12).
  /** @internal */ readSync(key: string): unknown {
    const e = this.#mirror.get(key);
    return live(e) ? e.value : undefined;
  }
  /** @internal */ keysSync(): string[] {
    return [...this.#mirror].filter(([, e]) => live(e)).map(([k]) => k);
  }
  /** @internal */ writeSync(
    entries: [string, unknown][],
    removals: string[],
  ): void {
    this.#alive();
    const updates = this.#prepare(entries);
    for (const [k, e] of this.#tombstones(removals)) updates.set(k, e);
    const { changes } = this.#applyLocal(updates, true);
    if (!Object.keys(changes).length) return;
    // API-12: forward to onChanged (never the window `storage` event), batched per task.
    if (!this.#queuedChanges) {
      this.#queuedChanges = {};
      queueMicrotask(() => {
        const c = this.#queuedChanges!;
        this.#queuedChanges = null;
        this.#emitChanges(c, "local");
      });
    }
    for (const [k, c] of Object.entries(changes)) {
      const q = this.#queuedChanges[k];
      const m = q
        ? {
            ...("oldValue" in q ? { oldValue: q.oldValue } : {}),
            ...("newValue" in c ? { newValue: c.newValue } : {}),
          }
        : c;
      // A key set and removed (or changed and changed back) within one batch has no net change.
      if (
        JSON.stringify(m.oldValue) === JSON.stringify(m.newValue) &&
        "oldValue" in m === "newValue" in m
      )
        delete this.#queuedChanges[k];
      else this.#queuedChanges[k] = m;
    }
  }

  #emitChanges(changes: StorageChanges, source: "local" | "remote"): void {
    if (Object.keys(changes).length) this.onChanged.emit({ changes, source });
  }

  async #checkUnprotected(): Promise<void> {
    // KP-14: once per device, when data exists but nothing can carry the secret elsewhere.
    if (
      this.#closed ||
      this.#protection !== "none" ||
      this.#meta.unprotectedFired
    )
      return;
    if (!this.keysSync().length) return;
    this.#meta.unprotectedFired = true;
    await this.#cache.setMeta({ unprotectedFired: true });
    this.onUnprotected.emit(undefined);
  }

  // ---------------------------------------------------------------- multi-tab (SYNC-14)

  #broadcast(
    msg:
      | { t: "changed"; keys: string[]; source: "local" | "remote" }
      | { t: "identity" },
  ): void {
    try {
      this.#channel?.postMessage(msg);
    } catch {
      /* closed */
    }
  }

  async #onMessage(msg: {
    t: string;
    keys?: string[];
    source?: "local" | "remote";
  }): Promise<void> {
    if (this.#closed) return;
    if (msg.t === "changed") {
      this.#emitChanges(
        await this.#reload(msg.keys ?? null),
        msg.source ?? "local",
      );
    } else if (msg.t === "identity") {
      const s = this.#remember ? await SecretHolder.load(this.#cache) : null;
      if (!s) {
        this.close();
        return;
      } // another tab unlinked
      const before = new Map(this.#mirror);
      this.#secret?.forget();
      this.#secret = s;
      const d = await this.#cache.getDevice();
      this.#token = {
        source: d.tokenSource ?? "unknown",
        remembered: true,
        since: d.tokenSince ?? null,
      };
      this.onToken.emit({ ...this.#token });
      this.#paused = false;
      await this.#adoptIdentity();
      const ch: StorageChanges = {};
      for (const k of new Set([...before.keys(), ...this.#mirror.keys()]))
        addChange(ch, k, before.get(k), this.#mirror.get(k));
      this.#emitChanges(ch, "remote");
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#subscribe();
    }
  }

  /** A view of local writes, taken before reading the cache; see #settledSince. */
  #mark(): { seq: number; unsettled: Set<string> } {
    return {
      seq: this.#writeSeq,
      unsettled: new Set([...this.#pending, ...this.#inFlight.keys()]),
    };
  }

  /** True when the mirror entry for `k` is still what a cache read started at `m` may replace. */
  #settledSince(
    k: string,
    m: { seq: number; unsettled: Set<string> },
  ): boolean {
    return (
      !m.unsettled.has(k) &&
      !this.#pending.has(k) &&
      !this.#inFlight.has(k) &&
      (this.#lastWrite.get(k) ?? 0) <= m.seq
    );
  }

  /** Re-read entries written by another tab. Keys with unsettled local writes are kept. */
  async #reload(keys: string[] | null): Promise<StorageChanges> {
    const mark = this.#mark();
    const fromCache = await this.#cache.loadItems();
    this.#meta = await this.#cache.getMeta();
    const ch: StorageChanges = {};
    for (const k of keys ??
      new Set([...fromCache.keys(), ...this.#mirror.keys()])) {
      if (!this.#settledSince(k, mark)) continue;
      const before = this.#mirror.get(k),
        after = fromCache.get(k);
      if (after) this.#mirror.set(k, after);
      else this.#mirror.delete(k);
      addChange(ch, k, before, after);
    }
    return ch;
  }

  async #lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const locks = this.#env.locks;
    return locks
      ? (locks.request(
          `burrow:${this.#env.ns}:${this.app}:${name}`,
          fn,
        ) as Promise<T>)
      : fn();
  }

  // ---------------------------------------------------------------- sync engine (§8)

  #schedulePush(): void {
    if (!this.#backend || this.#closed) return;
    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => void this.#sync(), this.#debounce); // SYNC-5 debounce + coalesce
  }

  async syncNow(): Promise<void> {
    this.#alive();
    await this.#flush();
    await this.#sync();
    if (this.#status === "error" || this.#status === "offline") {
      if (this.#error) throw this.#error;
    }
  }

  /** Run one sync pass, coalescing callers onto the running one. Never rejects. */
  #sync(keepalive = false): Promise<void> {
    if (!this.#backend || this.#paused || this.#closed || !this.#keys)
      return Promise.resolve();
    if (this.#running) {
      this.#rerun = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#rerun = false;
        this.#passStartedAt = Date.now();
        try {
          await this.#lock("sync", () => this.#pass(keepalive));
          this.#retryDelay = 0;
          this.#setStatus("idle");
        } catch (e) {
          this.#failed(e);
          break;
        }
      } while (this.#rerun && !this.#closed && !this.#paused);
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  #failed(e: unknown): void {
    const err = fromBackend(e);
    this.#log("error", { code: err.code });
    if (err.code === "decrypt-failed") {
      this.#paused = true; // ENC-6: pause until re-linked; the cache is untouched
      this.#setStatus("error", err);
    } else if (err.code === "conflict" || err.code === "item-too-large") {
      this.#setStatus("error", err); // retried on the next trigger; items stay dirty
    } else {
      // SYNC-9: network/quota -> exponential backoff, capped; dirty items are never dropped.
      this.#setStatus(
        "offline",
        err.code === "quota"
          ? err
          : new BurrowError("backend", undefined, { cause: e }),
      );
      const cap = Math.max(this.#interval, 5 * 60_000);
      this.#retryDelay = Math.min(
        cap,
        this.#retryDelay ? this.#retryDelay * 2 : 2_000,
      );
      clearTimeout(this.#retryTimer);
      this.#log("backoff", { ms: this.#retryDelay });
      this.#retryTimer = setTimeout(
        () => void this.#sync(),
        jitter(this.#retryDelay),
      );
    }
  }

  #cipher(id: string): DocCipher {
    return {
      key: this.#keys!.encKey,
      mac: this.#keys!.macKey,
      aad: id + this.app,
    };
  }

  async #openJson<T>(id: string, env: Envelope): Promise<T> {
    const pt = await open(this.#cipher(id), env);
    try {
      return JSON.parse(new TextDecoder().decode(pt)) as T;
    } catch (e) {
      throw new BurrowError("decrypt-failed", undefined, { cause: e });
    }
  }

  async #openItem(key: string, id: string, env: Envelope): Promise<Entry> {
    const item = await this.#openJson<Item>(id, env);
    if (item.v !== 1 || item.key !== key)
      throw new BurrowError(
        "decrypt-failed",
        "item does not belong to this key",
      );
    return item.deleted
      ? { ts: item.ts, deleted: true, rev: env.rev }
      : {
          value: item.value,
          ts: item.ts,
          h: await valueHash(item.value),
          rev: env.rev,
        };
  }

  async #h(e: Entry): Promise<Versioned> {
    if (!e.deleted && e.h === undefined) e.h = await valueHash(e.value);
    return versionOf(e);
  }

  /** Merge remote entries into cache and mirror; local wins when newer. Returns visible changes. */
  async #applyRemote(
    remote: Map<string, Entry>,
    changes: StorageChanges,
  ): Promise<void> {
    if (!remote.size) return;
    const mark = this.#mark();
    const local = new Map<string, Versioned>();
    for (const k of remote.keys()) {
      const e = this.#mirror.get(k);
      if (e) local.set(k, await this.#h(e));
    }
    const written = await this.#cache.updateItems(
      [...remote.keys()],
      (k, cur) => {
        const r = remote.get(k)!;
        if (!cur) return r;
        const cv =
          cur.h === undefined && !cur.deleted
            ? (local.get(k) ?? versionOf(cur))
            : versionOf(cur);
        if (compare(versionOf(r), cv) > 0) return r;
        if (r.rev !== undefined && (cur.rev ?? -1) < r.rev)
          return { ...cur, rev: r.rev };
        return undefined;
      },
    );
    for (const [k, e] of written) {
      if (!this.#settledSince(k, mark)) continue; // a newer local write wins; its flush rewrites the cache
      const before = this.#mirror.get(k);
      if (e) this.#mirror.set(k, e);
      else this.#mirror.delete(k);
      addChange(changes, k, before, e ?? undefined);
    }
  }

  /** SYNC-7: fetch specific item documents directly; ids are computable without the manifest. */
  async #fetchKeys(keys: string[]): Promise<void> {
    await this.#lock("sync", async () => {
      const ids = await Promise.all(keys.map((k) => docId(this.#keys!, k)));
      const envs = await this.#getMany(ids);
      const remote = new Map<string, Entry>();
      for (let i = 0; i < keys.length; i++)
        if (envs[i])
          remote.set(
            keys[i]!,
            await this.#openItem(keys[i]!, ids[i]!, envs[i]!),
          );
      const changes: StorageChanges = {};
      await this.#applyRemote(remote, changes);
      this.#finishRemote(changes);
    });
  }

  #getMany(ids: string[]): Promise<(Envelope | null)[]> {
    const b = this.#backend!;
    if (!ids.length) return Promise.resolve([]);
    return b.getMany ? b.getMany(ids) : Promise.all(ids.map((id) => b.get(id)));
  }

  #finishRemote(changes: StorageChanges): void {
    if (!Object.keys(changes).length) return;
    this.#broadcast({
      t: "changed",
      keys: Object.keys(changes),
      source: "remote",
    });
    if (!this.#suppressEmit) this.#emitChanges(changes, "remote"); // SYNC-13: once per pass
  }

  /** One sync pass: pull the manifest, fetch newer items, push dirty items, write the manifest last. */
  async #pass(keepalive: boolean): Promise<void> {
    const t0 = Date.now();
    const b = this.#backend!;
    const keys = this.#keys!;
    await this.#flush();
    this.#emitChanges(await this.#reload(null), "local"); // writes from other tabs, if any slipped by
    this.#setStatus("syncing");
    const changes: StorageChanges = {};
    // Item documents written this pass, kept across manifest retries so they are not rewritten.
    const ok = new Map<string, { key: string; ver: Versioned; rev: number }>();

    for (let attempt = 0; ; attempt++) {
      // 1. manifest
      const menv = await b.get(keys.base);
      let dir: Record<string, Versioned> = {};
      if (menv) {
        const m = await this.#openJson<Manifest>(keys.base, menv);
        if (m.v !== 1 || typeof m.items !== "object")
          throw new BurrowError("decrypt-failed", "bad manifest");
        dir = m.items;
      }
      let maxTs = this.#meta.maxRemoteTs ?? 0;
      for (const e of Object.values(dir)) maxTs = Math.max(maxTs, e.ts);
      this.#meta.maxRemoteTs = maxTs;

      // 2. pull: only items whose manifest entry beats the cached one (SYNC-6)
      const fetch: string[] = [];
      const remote = new Map<string, Entry>();
      for (const [k, e] of Object.entries(dir)) {
        const cur = this.#mirror.get(k);
        if (cur && compare(e, await this.#h(cur)) <= 0) continue;
        if (e.deleted)
          remote.set(k, {
            ts: e.ts,
            deleted: true,
            ...(cur?.rev !== undefined ? { rev: cur.rev } : {}),
          });
        else fetch.push(k);
      }
      const ids = await Promise.all(fetch.map((k) => docId(keys, k)));
      const envs = await this.#getMany(ids);
      for (let i = 0; i < fetch.length; i++) {
        const env = envs[i];
        if (env)
          remote.set(fetch[i]!, await this.#openItem(fetch[i]!, ids[i]!, env));
      }
      await this.#applyRemote(remote, changes);
      let pruned = 0;
      // Synced keys missing from an existing manifest were pruned tombstones: drop them.
      if (menv) {
        const gone = [...this.#mirror]
          .filter(([k, e]) => !e.dirty && !(k in dir))
          .map(([k]) => k);
        const mark = this.#mark();
        const dropped = await this.#cache.updateItems(gone, (_k, cur) =>
          cur && !cur.dirty ? null : undefined,
        );
        for (const k of dropped.keys()) {
          if (!this.#settledSince(k, mark)) continue;
          addChange(changes, k, this.#mirror.get(k), undefined);
          this.#mirror.delete(k);
          pruned++;
        }
      }
      // ERR-3: a merge line for each manifest read that brought remote entries or pruned keys.
      if (remote.size || pruned)
        this.#log("merge", { attempt, remote: remote.size, pruned });
      this.#log("pull", {
        rev: menv?.rev ?? null,
        fetched: fetch.length,
        ms: Date.now() - t0,
      });

      // 3. push dirty items, each on its own chain, in parallel
      const dirty = [...this.#mirror].filter(([, e]) => e.dirty);
      if (!dirty.length) {
        this.#meta.manifestRev = menv?.rev ?? null;
        break;
      }
      const results = await Promise.all(
        dirty.map(([k, e]) =>
          ok.get(k)?.ver.ts === e.ts ? null : this.#pushItem(k, e, keepalive),
        ),
      );
      for (const r of results) {
        if (!r) continue;
        if (r.adopted)
          await this.#applyRemote(new Map([[r.key, r.adopted]]), changes);
        ok.set(r.key, r);
      }

      // 4. the manifest, once, last (read-merge-write)
      const items = mergeDirectories(
        dir,
        Object.fromEntries([...ok].map(([k, r]) => [k, r.ver])),
        Date.now(),
      );
      const pt = utf8(JSON.stringify({ v: 1, items } satisfies Manifest));
      if (pt.length > HARD_MAX_PLAINTEXT)
        throw new BurrowError("item-too-large", "manifest is full");
      const rev = menv ? menv.rev + 1 : 0;
      try {
        await b.put(
          keys.base,
          await seal(this.#cipher(keys.base), keys.base, rev, pt, Date.now()),
          menv ? menv.rev : null,
          { keepalive },
        );
        this.#log("push", {
          rev,
          items: ok.size,
          bytes: pt.length,
          ms: Date.now() - t0,
        });
        this.#meta.manifestRev = rev;
        // Clear dirty only where nothing newer was written meanwhile.
        const written = await this.#cache.updateItems(
          [...ok.keys()],
          (k, cur) => {
            const r = ok.get(k)!;
            if (!cur) return undefined;
            if (cur.ts === r.ver.ts) {
              const { dirty: _d, ...rest } = cur;
              return {
                ...rest,
                rev: r.rev,
                ...(r.ver.h ? { h: r.ver.h } : {}),
              };
            }
            return { ...cur, rev: Math.max(cur.rev ?? -1, r.rev) };
          },
        );
        for (const [k, e] of written)
          if (e) {
            const m = this.#mirror.get(k);
            // A facade write that has not reached the cache yet keeps its own value and dirty flag.
            this.#mirror.set(k, m && m.ts !== e.ts ? { ...m, rev: e.rev } : e);
          }
        break;
      } catch (e) {
        if (
          !(e instanceof BackendError && e.code === "conflict") ||
          attempt >= CONFLICT_BACKOFF.length
        )
          throw e;
        this.#log("conflict", { doc: "manifest", attempt });
        await sleep(jitter(CONFLICT_BACKOFF[attempt]!));
      }
    }
    this.#meta.lastSyncAt = Date.now();
    await this.#cache.setMeta({
      manifestRev: this.#meta.manifestRev ?? null,
      maxRemoteTs: this.#meta.maxRemoteTs ?? 0,
      lastSyncAt: this.#meta.lastSyncAt,
    });
    this.#finishRemote(changes);
  }

  /** SYNC-8: read-merge-write one item document. Uses the cached rev, re-reads on conflict. */
  async #pushItem(
    key: string,
    e: Entry,
    keepalive: boolean,
  ): Promise<{ key: string; ver: Versioned; rev: number; adopted?: Entry }> {
    const b = this.#backend!;
    const id = await docId(this.#keys!, key);
    const ver = await this.#h(e);
    let rev: number | null | undefined = e.rev;
    for (let attempt = 0; ; attempt++) {
      if (rev === undefined) {
        const cur = await b.get(id);
        rev = cur ? cur.rev : null;
        if (cur) {
          const r = await this.#openItem(key, id, cur);
          if (compare(versionOf(r), ver) >= 0)
            return { key, ver: versionOf(r), rev: cur.rev, adopted: r };
        }
      }
      const item: Item = e.deleted
        ? { v: 1, key, value: null, ts: e.ts, deleted: true }
        : { v: 1, key, value: e.value, ts: e.ts };
      const next = rev === null ? 0 : rev + 1;
      try {
        await b.put(
          id,
          await seal(
            this.#cipher(id),
            id,
            next,
            utf8(JSON.stringify(item)),
            Date.now(),
          ),
          rev,
          { keepalive },
        );
        return { key, ver, rev: next };
      } catch (err) {
        if (
          !(err instanceof BackendError && err.code === "conflict") ||
          attempt >= CONFLICT_BACKOFF.length
        )
          throw err;
        this.#log("conflict", { doc: "item", attempt });
        rev = undefined;
        if (attempt) await sleep(jitter(CONFLICT_BACKOFF[attempt - 1]!));
      }
    }
  }

  // ---------------------------------------------------------------- unlock methods (§6)

  async protect(providerId?: string): Promise<void> {
    this.#alive();
    const list = providerId
      ? this.#providers.filter((p) => p.id === providerId)
      : this.#providers;
    if (!list.length) throw new BurrowError("no-provider");
    let chosen: KeyProvider | undefined;
    for (const p of list)
      if (await p.available()) {
        chosen = p;
        break;
      }
    if (!chosen)
      throw new BurrowError(
        providerId === "passkey" ? "prf-unsupported" : "no-provider",
      );
    const backend = this.#backend;
    if (!backend && chosen.id === "passkey")
      throw new BurrowError("backend", "a passkey keyslot needs a backend");
    await this.#secret!.use((rootSecret) =>
      chosen.enrol({
        app: this.app,
        rootSecret,
        backend: backend!,
        store: this.#providerStore(),
      }),
    );
    await this.#setProtection(protectionFor(chosen.id));
  }

  #providerStore(): ProviderStore {
    return {
      get: async (name) => (await this.#cache.getDevice())[`p:${name}`],
      set: (name, value) => this.#cache.setDevice({ [`p:${name}`]: value }),
    };
  }

  async #setProtection(p: Protection): Promise<void> {
    this.#protection = p;
    if (this.#remember) await this.#cache.setDevice({ protection: p });
  }

  async exportCode(): Promise<string> {
    this.#alive();
    return this.#secret!.use((s) => encodeSyncCode(s));
  }

  link(
    options: { provider?: string; code?: string; discardLocal?: boolean } = {},
  ): Promise<void> {
    return this.#link(options, "code");
  }

  async #link(
    options: { provider?: string; code?: string; discardLocal?: boolean },
    codeSource: TokenSource,
  ): Promise<void> {
    this.#alive();
    let secret: Uint8Array | null = null;
    let via: Protection = "none";
    let source: TokenSource = codeSource;
    if (options.code !== undefined) {
      secret = (await decodeSyncCode(options.code)).secret; // KP-12: bad-code before any network call
      via = "code";
    } else {
      // API-7 / KP-3: try each configured provider's recover() in order.
      const list = options.provider
        ? this.#providers.filter((p) => p.id === options.provider)
        : this.#providers;
      for (const p of list) {
        if (!(await p.available().catch(() => false))) continue;
        try {
          secret = await p.recover({
            app: this.app,
            interactive: true,
            backend: this.#backend!,
            store: this.#providerStore(),
          });
        } catch (e) {
          this.#log("recover-failed", {
            provider: p.id,
            code: e instanceof BurrowError ? e.code : "error",
          });
          secret = null;
        }
        if (secret) {
          via = protectionFor(p.id);
          source = via;
          break;
        }
      }
      if (!secret) throw new BurrowError("no-provider");
    }
    try {
      await this.#switchTo(secret, via, source, !!options.discardLocal);
    } finally {
      secret.fill(0);
    }
  }

  async #switchTo(
    secret: Uint8Array,
    via: Protection,
    source: TokenSource,
    discardLocal: boolean,
  ): Promise<void> {
    const same =
      (await deriveAppKeys(secret, this.app)).base === this.#keys!.base;
    if (same) {
      if (this.#protection === "none") await this.#setProtection(via);
      this.#paused = false;
      await this.#sync();
      return;
    }
    await this.#flush();
    if (!discardLocal && [...this.#mirror.values()].some((e) => e.dirty)) {
      await this.#sync(); // push it under the old secret first, if we can
      if ([...this.#mirror.values()].some((e) => e.dirty))
        throw new BurrowError("would-orphan");
    }
    const before = new Map(this.#mirror);
    const holder = await SecretHolder.wrap(secret);
    // A pass that started under the old secret must finish before the identity changes, and no
    // pass may start until it has: passes read the keys once, inside the sync lock.
    await this.#drain();
    await this.#lock("sync", async () => {
      await this.#lock("secret", async () => {
        if (this.#remember) await holder.persist(this.#cache);
      });
      this.#secret?.forget();
      this.#secret = holder;
      this.#protection = via;
      this.#token = { source, remembered: false, since: Date.now() };
      if (this.#remember)
        await this.#cache.setDevice({
          protection: via,
          tokenSource: source,
          tokenSince: this.#token.since!,
        });
      await this.#cache.setMeta({ owner: "" }); // the cache now belongs to nobody; #adoptIdentity resets it
      await this.#adoptIdentity();
      this.#paused = false;
    });
    this.#broadcast({ t: "identity" });
    this.onToken.emit({ ...this.#token });
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#subscribe();
    this.#suppressEmit = true;
    try {
      await this.#sync();
    } finally {
      this.#suppressEmit = false;
    }
    const ch: StorageChanges = {};
    for (const k of new Set([...before.keys(), ...this.#mirror.keys()]))
      addChange(ch, k, before.get(k), this.#mirror.get(k));
    this.#emitChanges(ch, "remote");
  }

  /** Wait for the running pass (and any rerun it has queued) to finish. */
  async #drain(): Promise<void> {
    while (this.#running) await this.#running;
  }

  async unlink(options: { discardLocal?: boolean } = {}): Promise<void> {
    this.#alive();
    await this.#flush();
    if (
      !options.discardLocal &&
      [...this.#mirror.values()].some((e) => e.dirty)
    ) {
      await this.#sync();
      if ([...this.#mirror.values()].some((e) => e.dirty))
        throw new BurrowError("would-orphan");
    }
    await this.#drain();
    // API-8: like clearing a session cookie. The cache and remote documents stay.
    this.#secret?.forget();
    this.#secret = null;
    await this.#cache.setDevice({
      kw: undefined,
      wrapped: undefined,
      protection: undefined,
      tokenSource: undefined,
      tokenSince: undefined,
    });
    this.#broadcast({ t: "identity" });
    this.close();
  }

  /** KP-13: a sync code in the URL fragment (#burrow=<code>) links this device. */
  async #readFragment(): Promise<void> {
    const loc = this.#env.location;
    const m = loc?.hash.match(/[#&]burrow=([^&]+)/);
    if (!loc || !m) return;
    const rest = loc.hash.replace(/[#&]?burrow=[^&]+/, "").replace(/^#?&?/, "");
    this.#env.history?.replaceState(
      null,
      "",
      loc.href.split("#")[0] + (rest ? "#" + rest : ""),
    );
    try {
      await this.#link({ code: decodeURIComponent(m[1]!) }, "link");
    } catch (e) {
      this.#setStatus(
        "error",
        e instanceof BurrowError ? e : new BurrowError("bad-code"),
      );
    }
  }

  // ---------------------------------------------------------------- export / import

  async exportJSON(): Promise<string> {
    this.#alive();
    return JSON.stringify(
      {
        burrow: 1,
        app: this.app,
        exportedAt: new Date().toISOString(),
        items: this.#pick(null),
      },
      null,
      2,
    );
  }

  async importJSON(json: string): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw new TypeError("not a Burrow export");
    }
    const items = (data as { items?: unknown })?.items;
    if (
      (data as { burrow?: unknown })?.burrow !== 1 ||
      !items ||
      typeof items !== "object" ||
      Array.isArray(items)
    )
      throw new TypeError("not a Burrow export");
    await this.set(items as Record<string, unknown>);
  }
}
