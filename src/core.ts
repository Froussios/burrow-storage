// Burrow core: remote storage only (D-57). It holds the app's keys in memory,
// encrypts and decrypts under the hood, and talks to the backend on every call.
// Nothing is written to disk, and nothing is queued: a remote failure rejects
// the call (§4, §8).
import { hex, randomBytes, sha256, utf8, zeroise } from "./bytes.js";
import type { CachedItem } from "./cache/types.js";
import { configuredBackend } from "./config.js";
import { type AppKeys, deriveAppKeys, docId } from "./codec/derive.js";
import {
  type DocCipher,
  assertJson,
  fits,
  open,
  seal,
} from "./codec/envelope.js";
import { decodeToken, encodeToken } from "./codec/token.js";
import { BackendError, BurrowError, fromBackend } from "./errors.js";
import {
  type Versioned,
  compare,
  mergeDirectories,
  nextTs,
  valueHash,
} from "./sync/merge.js";
import type {
  Backend,
  BurrowConfig,
  BurrowStorage,
  GetKeys,
  Item,
  Manifest,
  StoredDocument,
} from "./types.js";

const APP_RE = /^[a-z0-9-]{1,64}$/;
const CONFLICT_BACKOFF = [200, 800, 3000];
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One key's remote state: its value or tombstone, version and revision. */
export type Entry = CachedItem;

export const live = (e: Entry | null | undefined): e is Entry =>
  !!e && !e.deleted;
export const versionOf = (e: Entry): Versioned =>
  e.deleted ? { ts: e.ts, deleted: true } : { ts: e.ts, h: e.h ?? "" };

/** What a pull found in the store. */
export interface Pulled {
  /**
   * The manifest's directory for a pull of every key; null for a pull of
   * named keys, or when the store has no manifest yet.
   */
  listed: Record<string, Versioned> | null;
  /**
   * Remote state per key, null where no document exists. A pull of every key
   * leaves out listed keys whose version is not newer than the caller's.
   */
  items: Map<string, Entry | null>;
}

/**
 * @internal The seam `offline()` builds on. It exists for the wrapper only and
 *   is not public API (D-57): it is reachable through `remoteOf()`, not through
 *   the store object.
 */
export interface Remote {
  readonly app: string;
  /** A fingerprint of the token: names the local copy, opens nothing (D-8). */
  readonly identity: string;
  readonly closed: boolean;
  pull(
    keys: string[] | null,
    have: (key: string) => Versioned | undefined,
  ): Promise<Pulled>;
  /**
   * Write entries with last-writer-wins: a newer remote version is adopted
   * instead. Keys in `fresh` are new writes and are stamped above whatever the
   * store holds; deletes in `ifPresent` are skipped where the store has no
   * document. Resolves with each key's remote state afterwards (null: a
   * skipped delete).
   */
  push(
    entries: Map<string, Entry>,
    options: PushOptions,
  ): Promise<Map<string, Entry | null>>;
  /**
   * D-48: rewrite every listed item and the manifest without changing logical
   * versions. `local` supplies listed items whose document is missing.
   */
  renew(local: ReadonlyMap<string, Entry>): Promise<Map<string, Entry | null>>;
  /**
   * Call `onChange` when another writer changes the manifest, `onExpired` on
   * an expiry stub. Null when the backend cannot notify.
   */
  watch(onChange: () => void, onExpired: () => void): (() => void) | null;
}

export interface PushOptions {
  fresh?: ReadonlySet<string>;
  ifPresent?: ReadonlySet<string>;
}

const remotes = new WeakMap<object, Remote>();

/** @internal The seam of a store returned by `burrow()`. */
export function remoteOf(store: unknown): Remote | undefined {
  return typeof store === "object" && store !== null
    ? remotes.get(store)
    : undefined;
}

/**
 * Validate and stamp writes. Throws TypeError / item-too-large before anything
 * is written (ERR-1). Shared by the core and the offline wrapper.
 */
export async function prepareWrites(
  items: Record<string, unknown>,
  previousTs: (key: string) => number | undefined,
  maxRemoteTs: number | undefined,
): Promise<Map<string, Entry>> {
  if (!items || typeof items !== "object")
    throw new TypeError("set() takes an object of key/value pairs");
  const now = Date.now();
  const out = new Map<string, Entry>();
  for (const [k, value] of Object.entries(items)) {
    if (value === undefined)
      throw new TypeError(`value for "${k}" is undefined`);
    assertJson(value, k);
    const ts = nextTs(now, previousTs(k), maxRemoteTs);
    // D-60: the store's document limit is the only one, checked before the
    // wrapper queues a write that could never be sent.
    if (!(await fits(utf8(JSON.stringify({ v: 1, key: k, value, ts })))))
      throw new BurrowError(
        "item-too-large",
        `"${k}" does not fit in one stored document`,
      );
    out.set(k, { value: structuredClone(value), ts });
  }
  for (const e of out.values()) e.h = await valueHash(e.value);
  return out;
}

/** Tombstones for `keys`, stamped above their previous versions (SYNC-12). */
export function tombstones(
  keys: string | string[],
  previous: (key: string) => Entry | undefined,
  maxRemoteTs: number | undefined,
): Map<string, Entry> {
  const now = Date.now();
  const out = new Map<string, Entry>();
  for (const k of typeof keys === "string" ? [keys] : keys) {
    if (typeof k !== "string") throw new TypeError("keys must be strings");
    const rev = previous(k)?.rev;
    out.set(k, {
      ts: nextTs(now, previous(k)?.ts, maxRemoteTs),
      deleted: true,
      ...(rev === undefined ? {} : { rev }),
    });
  }
  return out;
}

/** The keys a `get()` names, or null for all of them. */
export function keyList(keys: GetKeys): string[] | null {
  if (keys === null || keys === undefined) return null;
  if (typeof keys === "string") return [keys];
  if (Array.isArray(keys)) return keys;
  return Object.keys(keys);
}

/** API-3: the result of `get(keys)` from the entries found. */
export function pick(
  keys: GetKeys,
  found: ReadonlyMap<string, Entry | null>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const one = (k: string, dflt?: { v: unknown }) => {
    const e = found.get(k);
    if (live(e)) out[k] = structuredClone(e.value);
    else if (dflt) out[k] = dflt.v;
  };
  if (keys === null || keys === undefined) for (const k of found.keys()) one(k);
  else if (typeof keys === "string") one(keys);
  else if (Array.isArray(keys)) keys.forEach((k) => one(k));
  else for (const [k, v] of Object.entries(keys)) one(k, { v });
  return out;
}

let warnedNoAuth = false;

/** Generate a fresh storage token (KP-1) for an app that keeps its own. */
export async function generateToken(): Promise<string> {
  const secret = randomBytes(32);
  try {
    return await encodeToken(secret);
  } finally {
    zeroise(secret);
  }
}

export class Core implements BurrowStorage {
  readonly app: string;
  readonly #backend: Backend;
  #keys: AppKeys | null;
  readonly #identity: string;
  // The in-memory content cache: what this instance last saw of each key.
  readonly #known = new Map<string, Entry>();
  // Items written whose manifest entry has not been published yet.
  #unlisted = new Map<string, Entry>();
  #maxRemoteTs = 0;
  #manifestRev: number | null = null;
  // Writes from this instance reach the store in call order.
  #writes: Promise<unknown> = Promise.resolve();

  private constructor(
    app: string,
    backend: Backend,
    keys: AppKeys,
    identity: string,
  ) {
    this.app = app;
    this.#backend = backend;
    this.#keys = keys;
    this.#identity = identity;
  }

  /**
   * Validate the config and derive the keys. No network call, so it resolves
   * offline too (D-57).
   */
  static async create(config: BurrowConfig): Promise<Core> {
    const app = config?.app;
    if (typeof app !== "string" || !APP_RE.test(app))
      throw new TypeError("app must match /^[a-z0-9-]{1,64}$/");
    if (config.backend === undefined || config.backend === null)
      throw new TypeError("burrow() needs a backend");
    // KP-12: bad-token before anything else touches the token.
    const secret = await decodeToken(config.token);
    let keys: AppKeys;
    try {
      keys = await deriveAppKeys(secret, app);
    } finally {
      zeroise(secret); // SEC-1: only the non-extractable keys remain
    }
    let backend: Backend;
    try {
      backend = await configuredBackend(config.backend);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      // Factory errors may contain secrets, so retain only a fixed message.
      throw new BurrowError("backend", "backend configuration failed");
    }
    if (!backend.capabilities.writeAuth && !warnedNoAuth) {
      warnedNoAuth = true; // ENC-9
      console.warn(
        `[burrow] backend "${backend.id}" cannot enforce the write-token chain; anyone who learns an id can overwrite it.`,
      );
    }
    const identity = hex(await sha256(utf8("owner:" + keys.base))).slice(0, 16);
    const core = new Core(app, backend, keys, identity);
    remotes.set(core, core.#seam());
    return core;
  }

  #seam(): Remote {
    const core = this;
    return {
      app: this.app,
      identity: this.#identity,
      get closed() {
        return core.#keys === null;
      },
      pull: (keys, have) => this.#call(() => this.#pull(keys, have)),
      push: (entries, options) =>
        this.#call(() => this.#write(() => this.#push(entries, options))),
      renew: (local) => this.#call(() => this.#write(() => this.#renew(local))),
      watch: (onChange, onExpired) => this.#watch(onChange, onExpired),
    };
  }

  #k(): AppKeys {
    if (!this.#keys) throw new BurrowError("closed", "this store was closed");
    return this.#keys;
  }

  /** Run a remote operation; every failure becomes a BurrowError (API-13). */
  async #call<T>(fn: () => Promise<T>): Promise<T> {
    this.#k();
    try {
      return await fn();
    } catch (e) {
      throw fromBackend(e);
    }
  }

  #write<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(fn);
    this.#writes = run.catch(() => {});
    return run;
  }

  close(): void {
    this.#keys = null; // the keys are non-extractable; dropping them is all
    this.#known.clear();
    this.#unlisted.clear();
  }

  // ---------------------------------------------------- the public API

  async get(keys?: GetKeys): Promise<Record<string, unknown>> {
    const list = keyList(keys);
    const found = await this.#call(async () => {
      const pulled = await this.#pull(list, (k) => {
        const e = this.#known.get(k);
        return e && versionOf(e);
      });
      if (list) return pulled.items;
      const out = new Map<string, Entry | null>();
      for (const k of Object.keys(pulled.listed ?? {}))
        out.set(k, pulled.items.get(k) ?? this.#known.get(k) ?? null);
      for (const [k, e] of this.#unlisted) if (!out.has(k)) out.set(k, e);
      return out;
    });
    return pick(keys, found);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.#k();
    const entries = await prepareWrites(
      items,
      (k) => this.#known.get(k)?.ts,
      this.#maxRemoteTs,
    );
    for (const [k, e] of entries) {
      const rev = this.#known.get(k)?.rev;
      if (rev !== undefined) e.rev = rev; // D-10
    }
    await this.#call(() =>
      this.#write(() =>
        this.#push(entries, { fresh: new Set(entries.keys()) }),
      ),
    );
  }

  async remove(keys: string | string[]): Promise<void> {
    this.#k();
    const entries = tombstones(
      keys,
      (k) => this.#known.get(k),
      this.#maxRemoteTs,
    );
    if (!entries.size) return;
    const named = new Set(entries.keys());
    // Removing a key the store does not have is a no-op, as in chrome.storage.
    await this.#call(() =>
      this.#write(() =>
        this.#push(entries, { fresh: named, ifPresent: named }),
      ),
    );
  }

  async clear(): Promise<void> {
    const all = await this.get();
    await this.remove(Object.keys(all)); // SYNC-12
  }

  // ---------------------------------------------------- documents

  #cipher(id: string): DocCipher {
    const keys = this.#k();
    return { key: keys.encKey, mac: keys.macKey, aad: id + this.app };
  }

  #checkExpiry(env: StoredDocument | null): void {
    if (env && "x" in env) throw new BurrowError("expired");
  }

  async #openJson<T>(id: string, env: StoredDocument): Promise<T> {
    if ("x" in env) throw new BurrowError("expired");
    const pt = await open(this.#cipher(id), env);
    try {
      return JSON.parse(new TextDecoder().decode(pt)) as T;
    } catch (e) {
      throw new BurrowError("decrypt-failed", undefined, { cause: e });
    }
  }

  async #openItem(
    key: string,
    id: string,
    env: StoredDocument,
  ): Promise<Entry> {
    const item = await this.#openJson<Item>(id, env);
    if (item.v !== 1 || item.key !== key)
      throw new BurrowError(
        "decrypt-failed",
        "item does not belong to this key",
      );
    const e: Entry = item.deleted
      ? { ts: item.ts, deleted: true, rev: env.rev }
      : {
          value: item.value,
          ts: item.ts,
          h: await valueHash(item.value),
          rev: env.rev,
        };
    this.#note(key, e);
    return e;
  }

  async #openManifest(
    menv: StoredDocument | null,
  ): Promise<Record<string, Versioned> | null> {
    this.#checkExpiry(menv);
    if (!menv) return null;
    const keys = this.#k();
    const m = await this.#openJson<Manifest>(keys.base, menv);
    if (m.v !== 1 || !m.items || typeof m.items !== "object")
      throw new BurrowError("decrypt-failed", "bad manifest");
    this.#manifestRev = menv.rev;
    for (const e of Object.values(m.items))
      this.#maxRemoteTs = Math.max(this.#maxRemoteTs, e.ts);
    return m.items;
  }

  /** Remember the newer of what this instance knew and `e`. */
  #note(key: string, e: Entry): void {
    this.#maxRemoteTs = Math.max(this.#maxRemoteTs, e.ts);
    const cur = this.#known.get(key);
    if (!cur || compare(versionOf(e), versionOf(cur)) >= 0)
      this.#known.set(key, e);
    else if (e.rev !== undefined && (cur.rev ?? -1) < e.rev)
      this.#known.set(key, { ...cur, rev: e.rev });
  }

  #getMany(ids: string[]): Promise<(StoredDocument | null)[]> {
    const b = this.#backend;
    if (!ids.length) return Promise.resolve([]);
    return b.getMany ? b.getMany(ids) : Promise.all(ids.map((id) => b.get(id)));
  }

  /** Fetch item documents; an expiry stub anywhere rejects `expired`. */
  async #fetch(keys: string[]): Promise<Map<string, Entry | null>> {
    const k = this.#k();
    const ids = await Promise.all(keys.map((key) => docId(k, key)));
    const envs = await this.#getMany(ids);
    envs.forEach((env) => this.#checkExpiry(env));
    const out = new Map<string, Entry | null>();
    for (let i = 0; i < keys.length; i++)
      out.set(
        keys[i]!,
        envs[i] ? await this.#openItem(keys[i]!, ids[i]!, envs[i]!) : null,
      );
    return out;
  }

  /**
   * SYNC-7: named keys are fetched directly, since their ids are computable.
   * All keys: read the manifest and fetch the items newer than `have`.
   */
  async #pull(
    keys: string[] | null,
    have: (key: string) => Versioned | undefined,
  ): Promise<Pulled> {
    if (keys) return { listed: null, items: await this.#fetch(keys) };
    const dir = await this.#openManifest(
      await this.#backend.get(this.#k().base),
    );
    const items = new Map<string, Entry | null>();
    if (!dir) return { listed: null, items };
    const fetch: string[] = [];
    for (const [k, e] of Object.entries(dir)) {
      const h = have(k);
      if (h && compare(e, h) <= 0) continue;
      if (!e.deleted) fetch.push(k);
      else {
        const tomb: Entry = { ts: e.ts, deleted: true };
        this.#note(k, tomb);
        items.set(k, tomb);
      }
    }
    for (const [k, e] of await this.#fetch(fetch)) items.set(k, e);
    return { listed: dir, items };
  }

  /** Write items, then list them in the manifest. */
  async #push(
    entries: Map<string, Entry>,
    { fresh, ifPresent }: PushOptions,
    renew = false,
  ): Promise<Map<string, Entry | null>> {
    const keys = [...entries.keys()];
    const settled = await Promise.allSettled(
      keys.map((k) =>
        this.#pushItem(
          k,
          entries.get(k)!,
          !!fresh?.has(k),
          !!ifPresent?.has(k),
          renew,
        ),
      ),
    );
    const results = new Map<string, Entry | null>();
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") results.set(keys[i]!, r.value);
    });
    // Items already written are listed by the next successful publish.
    for (const [k, r] of results) if (r) this.#unlisted.set(k, r);
    // An observed expiry dominates other concurrent transport failures.
    for (const r of settled)
      if (r.status === "rejected" && r.reason?.code === "expired")
        throw r.reason;
    for (const r of settled) if (r.status === "rejected") throw r.reason;
    const published = await this.#publish(new Set(results.keys()), renew);
    for (const k of results.keys())
      if (published.has(k)) results.set(k, published.get(k)!);
    return results;
  }

  /**
   * SYNC-8: read-merge-write one item document. Uses the known rev, re-reads
   * on conflict (D-10).
   */
  async #pushItem(
    key: string,
    e: Entry,
    restamp: boolean,
    ifPresent: boolean,
    renew: boolean,
  ): Promise<Entry | null> {
    const b = this.#backend;
    const id = await docId(this.#k(), key);
    let rev: number | null | undefined = e.rev;
    for (let attempt = 0; ; attempt++) {
      if (rev === undefined) {
        const cur = await b.get(id);
        this.#checkExpiry(cur);
        rev = cur ? cur.rev : null;
        if (cur) {
          const r = await this.#openItem(key, id, cur);
          if (restamp) {
            // A fresh write: stamp it above what the store holds.
            if (e.deleted && r.deleted) return r;
            e = { ...e, ts: nextTs(e.ts, r.ts, this.#maxRemoteTs) };
          } else if (compare(versionOf(r), versionOf(e)) >= 0) {
            if (!renew) return r;
            e = r;
          }
        } else if (e.deleted && ifPresent) return null;
      }
      const item: Item = e.deleted
        ? { v: 1, key, value: null, ts: e.ts, deleted: true }
        : { v: 1, key, value: e.value, ts: e.ts };
      const next = rev === null ? 0 : rev + 1;
      try {
        const env = await seal(
          this.#cipher(id),
          id,
          next,
          utf8(JSON.stringify(item)),
          Date.now(),
        );
        await b.put(id, env, rev);
        const { dirty: _d, ...rest } = e;
        const written: Entry = e.deleted
          ? { ts: e.ts, deleted: true, rev: next }
          : { ...rest, h: e.h ?? (await valueHash(e.value)), rev: next };
        this.#note(key, written);
        return written;
      } catch (err) {
        if (
          !(err instanceof BackendError && err.code === "conflict") ||
          attempt >= CONFLICT_BACKOFF.length
        )
          throw err;
        rev = undefined;
        if (attempt) await sleep(jitter(CONFLICT_BACKOFF[attempt - 1]!));
      }
    }
  }

  /**
   * Publish the manifest with every unlisted result, merging with what other
   * writers listed. Resolves with the results as published.
   */
  async #publish(
    fresh: ReadonlySet<string>,
    force: boolean,
  ): Promise<Map<string, Entry>> {
    const b = this.#backend;
    const keys = this.#k();
    const pending = this.#unlisted;
    this.#unlisted = new Map();
    if (!pending.size && !force) return pending;
    try {
      for (let attempt = 0; ; attempt++) {
        const menv = await b.get(keys.base);
        const dir = (await this.#openManifest(menv)) ?? {};
        // D-46: a result from an earlier attempt or an earlier call that the
        // directory does not list is read again before it is published.
        for (const [k, r] of [...pending]) {
          if (k in dir || (attempt === 0 && fresh.has(k))) continue;
          const now = (await this.#fetch([k])).get(k);
          if (!now) pending.delete(k);
          else if (compare(versionOf(now), versionOf(r)) >= 0)
            pending.set(k, now);
        }
        const listed = [...pending].every(
          ([k, r]) => dir[k] && compare(dir[k]!, versionOf(r)) === 0,
        );
        if (listed && !(force && menv)) return pending;
        const items = mergeDirectories(
          dir,
          Object.fromEntries([...pending].map(([k, r]) => [k, versionOf(r)])),
          Date.now(),
        );
        const pt = utf8(JSON.stringify({ v: 1, items } satisfies Manifest));
        if (!(await fits(pt)))
          throw new BurrowError("item-too-large", "manifest is full");
        const rev = menv ? menv.rev + 1 : 0;
        try {
          const env = await seal(
            this.#cipher(keys.base),
            keys.base,
            rev,
            pt,
            Date.now(),
          );
          await b.put(keys.base, env, menv ? menv.rev : null);
          this.#manifestRev = rev;
          return pending;
        } catch (e) {
          if (
            !(e instanceof BackendError && e.code === "conflict") ||
            attempt >= CONFLICT_BACKOFF.length
          )
            throw e;
          await sleep(jitter(CONFLICT_BACKOFF[attempt]!));
        }
      }
    } catch (e) {
      // SYNC-9: still unlisted; the next publish tries again.
      for (const [k, r] of pending)
        if (!this.#unlisted.has(k)) this.#unlisted.set(k, r);
      throw e;
    }
  }

  async #renew(
    local: ReadonlyMap<string, Entry>,
  ): Promise<Map<string, Entry | null>> {
    const dir = await this.#openManifest(
      await this.#backend.get(this.#k().base),
    );
    if (!dir) return new Map();
    const keys = Object.keys(dir);
    const found = await this.#fetch(keys);
    const entries = new Map<string, Entry>();
    for (const k of keys) {
      const e = found.get(k) ?? local.get(k);
      if (e) entries.set(k, e);
      else if (dir[k]!.deleted)
        entries.set(k, { ts: dir[k]!.ts, deleted: true });
      // A listed live document that is missing everywhere cannot be renewed.
      else throw new BackendError("network", "missing item");
    }
    return this.#push(entries, {}, true);
  }

  #watch(onChange: () => void, onExpired: () => void): (() => void) | null {
    const b = this.#backend;
    if (!b.capabilities.subscribe || !b.subscribe || !this.#keys) return null;
    // SYNC-6: the manifest only; the subscriber fetches what changed.
    return b.subscribe(this.#keys.base, (env) => {
      if ("x" in env) onExpired();
      else if (env.rev !== this.#manifestRev) onChange();
    });
  }
}
