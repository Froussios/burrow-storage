import type { BurrowError } from "./errors.js";
import type { BurrowEvent } from "./events.js";

/** Every stored document — manifest, item, keyslot — has this shape (§7). */
export interface Envelope {
  v: 1;
  /** 12 bytes, base64url (16 chars), fresh per write. */
  iv: string;
  /**
   * base64url AES-256-GCM(key, iv, plaintext, aad = id || app || String(rev)).
   */
  ct: string;
  /** Monotonically increasing per document, starts at 0. */
  rev: number;
  /** Writer's wall clock, ms. */
  ts: number;
  /** One-time write token for this rev (ENC-7). */
  tok: string;
  /** Lowercase hex SHA-256 of the token the next rev must present. */
  next: string;
  /** Plaintext was deflate-raw compressed before encryption. */
  z?: true;
}

/** Plaintext of the manifest document (id = base): the user's key directory. */
export interface Manifest {
  v: 1;
  items: Record<string, ManifestEntry>;
}

export interface ManifestEntry {
  ts: number;
  deleted?: true;
  /** Merge tie-break: hash of the serialised value (docs/decisions.md D-5). */
  h?: string;
}

/** Plaintext of an item document (id = docId(key)). */
export interface Item {
  v: 1;
  key: string;
  /**
   * Any JSON value; null after deletion (documents are never removed, FS-6).
   */
  value: unknown;
  ts: number;
  deleted?: true;
}

/** What a backend can do. The core reads both. */
export interface BackendCapabilities {
  /**
   * The store itself verifies the write-token chain (ENC-7): an update must
   * present a `tok` whose SHA-256 equals the stored `next`, at `rev` = stored
   * `rev` + 1. When false, Burrow warns once in the console, because anyone who
   * learns an id could overwrite that document.
   */
  writeAuth: boolean;
  /**
   * The backend implements `subscribe()`; otherwise Burrow relies on polling
   * alone.
   */
  subscribe: boolean;
}

/**
 * Where encrypted documents live: the one swappable seam (§9). A backend stores
 * opaque envelopes at opaque 43-character ids and knows nothing about users,
 * apps, keys or encryption; manifests, items and keyslots look identical to it.
 * Every failure must reject with a `BackendError`. The conformance suite in
 * `test/conformance/suite.ts` checks an implementation. Guide:
 * docs/extending.md.
 */
export interface Backend {
  /**
   * Short name shown by `inspect().backend` and in warnings, e.g. "firestore".
   */
  readonly id: string;
  /** What this backend can do; see `BackendCapabilities`. */
  readonly capabilities: BackendCapabilities;
  /**
   * Read the document stored at `id`, exactly as it was written.
   * Resolves `null` when no document exists. Rejects
   * `BackendError("network" | "quota")`.
   */
  get(id: string): Promise<Envelope | null>;
  /**
   * Optional batch read: one result per id, in the same order, `null` for a
   * missing document. Without it, Burrow calls `get()` for each id in parallel.
   */
  getMany?(ids: string[]): Promise<(Envelope | null)[]>;
  /**
   * Write `env` at `id` with an optimistic-concurrency check (BE-1).
   * `expectedRev` null means create: reject `conflict` if the document exists.
   * Otherwise the stored `rev` must equal `expectedRev`, or reject `conflict`.
   * Two concurrent writers at the same `expectedRev` must see exactly one
   * success. A `writeAuth` store also rejects `unauthorized` for a broken token
   * chain or a malformed envelope. Other rejections: `too-large`, `quota`,
   * `network`.
   */
  put(id: string, env: Envelope, expectedRev: number | null): Promise<void>;
  /**
   * Optional push notifications for one document. Call `onChange` with each new
   * envelope stored at `id`, and return a function that stops them. Burrow
   * subscribes to the user's manifest only.
   */
  subscribe?(id: string, onChange: (env: Envelope) => void): () => void;
}

/** Options for `burrow()`. Only `app` is required. */
export interface BurrowConfig {
  /**
   * Names the app's namespace in the cache and in key derivation. Must match
   * /^[a-z0-9-]{1,64}$/.
   */
  app: string;
  /**
   * Where to sync. Default: a FirestoreBackend from the page's config, or
   * local-only if there is none.
   */
  backend?: Backend;
  /**
   * Local cache. Default `"indexeddb"`, or `"memory"` when `rememberDevice` is
   * false.
   */
  cache?: "indexeddb" | "memory";
  /**
   * Remember the token across page loads. Default true; false keeps it in
   * memory only, for shared computers.
   */
  rememberDevice?: boolean;
  /**
   * Polling interval while the page is visible, in ms. Default 30 000; 0
   * disables polling.
   */
  syncIntervalMs?: number;
  /**
   * How long local writes are coalesced before a push, in ms. Default 1 500.
   */
  debounceMs?: number;
  /**
   * Size limit per item, in bytes of JSON. Default 200 000; clamped to 749 000.
   */
  maxItemBytes?: number;
  /**
   * Log one console.debug line per sync event. Never logs ids, tokens, keys or
   * values.
   */
  debug?: boolean;
}

export type Status = "idle" | "syncing" | "offline" | "error";

/**
 * How this device got its storage token (the root secret): "generated" here on
 * first use (KP-1), "token" when passed to `link()` without a `source`, the
 * site's own label when passed with one (e.g. "passkey"), or "unknown" for
 * tokens stored before this was recorded.
 */
export type TokenSource = "generated" | "token" | "unknown" | (string & {});

export interface TokenInfo {
  source: TokenSource;
  /**
   * True when the token was loaded from this browser's storage rather than
   * obtained this page load.
   */
  remembered: boolean;
  /** When this device obtained the token (ms), if known. */
  since: number | null;
}

export type StorageChanges = Record<
  string,
  { oldValue?: unknown; newValue?: unknown }
>;
export interface ChangedEvent {
  changes: StorageChanges;
  source: "local" | "remote";
}
export interface StatusEvent {
  status: Status;
  error?: BurrowError;
}

export interface Inspection {
  status: Status;
  manifestRev: number | null;
  dirtyKeys: number;
  lastSyncAt: number | null;
  backend: string;
}

export type GetKeys =
  null | undefined | string | string[] | Record<string, unknown>;

/**
 * The store for one app, returned by `burrow()`. Shaped like chrome.storage's
 * StorageArea (§5). Reference: docs/api.md.
 */
export interface BurrowArea {
  /**
   * Read from the local cache: all keys (no argument or null), one key, a list
   * of keys, or an object whose values are defaults for missing keys.
   * `{ fresh: true }` fetches from the store first.
   */
  get(
    keys?: GetKeys,
    opts?: { fresh?: boolean },
  ): Promise<Record<string, unknown>>;
  /**
   * Write JSON values. Validates every key first, so an invalid batch writes
   * nothing: non-JSON values reject with TypeError, oversized items with
   * `item-too-large`. Resolves once stored locally; never rejects because the
   * store is unreachable.
   */
  set(items: Record<string, unknown>): Promise<void>;
  /**
   * Delete keys; a tombstone carries the delete to other devices. Missing keys
   * are ignored.
   */
  remove(keys: string | string[]): Promise<void>;
  /** Delete every key. */
  clear(): Promise<void>;
  /**
   * UTF-8 length of each key plus its JSON value, as chrome.storage counts it.
   */
  getBytesInUse(keys?: null | string | string[]): Promise<number>;
  /**
   * Fires after local writes (`source: "local"`, any tab of this device) and
   * after pulls from the store (`"remote"`).
   */
  readonly onChanged: BurrowEvent<ChangedEvent>;

  /**
   * "idle", "syncing", "offline" (network or quota) or "error" (decrypt-failed,
   * conflict, item-too-large).
   */
  readonly status: Status;
  /**
   * Where the token in use came from. Changes on link(); onToken fires then.
   */
  readonly token: TokenInfo;
  /**
   * Fires when this device's token changes: after `link()` in this tab or
   * another.
   */
  readonly onToken: BurrowEvent<TokenInfo>;
  /** Fires on every change of status or error. */
  readonly onStatus: BurrowEvent<StatusEvent>;
  /**
   * Adopt an existing storage token on this device: one the user typed or
   * pasted, or one a backup returned (e.g. `passkeyBackup().restore()`).
   * Replaces the token for every app on the origin. `source` labels it in
   * `token.source` (default "token"). Rejects `bad-token` before any network
   * call, and `would-orphan` if this app has unsynced writes, unless
   * `discardLocal` is true.
   */
  link(options: {
    token: string;
    source?: string;
    discardLocal?: boolean;
  }): Promise<void>;
  /**
   * Forget the token on this device, like logging out, and close this instance.
   * Same `would-orphan` guard as `link()`.
   */
  unlink(options?: { discardLocal?: boolean }): Promise<void>;
  /**
   * Flush pending writes and run one sync pass. Rejects with the error if the
   * pass fails.
   */
  syncNow(): Promise<void>;
  /**
   * The storage token: 56 Crockford base32 characters in 14 groups of four.
   * Show it to the user, or hand it to a backup such as `passkeyBackup()`.
   */
  exportToken(): Promise<string>;
  /**
   * Plaintext export of this app's data:
   * `{ burrow: 1, app, exportedAt, items }`.
   */
  exportJSON(): Promise<string>;
  /**
   * Write the items of an `exportJSON()` export with `set()`. Rejects TypeError
   * for anything else.
   */
  importJSON(json: string): Promise<void>;
  /** A plain snapshot of the sync state, for a debug panel. */
  inspect(): Inspection;
  /**
   * A synchronous DOM `Storage` over the same keys, for replacing
   * `localStorage`.
   */
  readonly storage: Storage;
}
