import type { BurrowError } from "./errors.js";
import type { BurrowEvent } from "./events.js";

/** Every stored document — manifest or item — has this shape (§7). */
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

/** Operator-created marker: content is gone, but the write chain survives. */
export interface ExpiredStub {
  x: true;
  rev: number;
  next: string;
}

/** Backend reads distinguish never-created documents from expired content. */
export type StoredDocument = Envelope | ExpiredStub;

export interface PutOptions {
  /** Explicitly replace an expired stub using its existing write chain. */
  replaceExpired?: true;
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
   * The backend implements `subscribe()`; otherwise the offline wrapper learns
   * of remote changes only when it reads or syncs.
   */
  subscribe: boolean;
}

/**
 * Where encrypted documents live: the one swappable seam (§9). A backend stores
 * opaque envelopes or owner-created expiry stubs at opaque 43-character ids and
 * knows nothing about users, apps, keys or encryption; manifests and items
 * look identical to it. Every failure must reject with a
 * `BackendError`. The conformance suite in `test/conformance/suite.ts` checks
 * an implementation. Guide: docs/extending.md.
 */
export interface Backend {
  /** Short name shown in warnings, e.g. "firestore". */
  readonly id: string;
  /** What this backend can do; see `BackendCapabilities`. */
  readonly capabilities: BackendCapabilities;
  /**
   * Read a live envelope or distinct `{ x: true, rev, next }` expired stub.
   * Resolves `null` when no document exists. Rejects
   * `BackendError("network" | "quota")`.
   */
  get(id: string): Promise<StoredDocument | null>;
  /**
   * Optional batch read: one result per id, in the same order, `null` for a
   * missing document. Without it, Burrow calls `get()` for each id in parallel.
   */
  getMany?(ids: string[]): Promise<(StoredDocument | null)[]>;
  /**
   * Write `env` at `id` with an optimistic-concurrency check (BE-1).
   * `expectedRev` null means create: reject `conflict` if the document exists.
   * Otherwise the stored `rev` must equal `expectedRev`, or reject `conflict`.
   * Two concurrent writers at the same `expectedRev` must see exactly one
   * success. A `writeAuth` store also rejects `unauthorized` for a broken token
   * chain or a malformed envelope. Other rejections: `too-large`, `quota`,
   * `network`. Atomically reject `expired` if the current document is a stub,
   * unless `options.replaceExpired` explicitly permits replacing it. Opt-in
   * still requires the expected revision and valid next-token chain.
   */
  put(
    id: string,
    env: Envelope,
    expectedRev: number | null,
    options?: PutOptions,
  ): Promise<void>;
  /**
   * Optional push notifications for one document. Call `onChange` with each new
   * live envelope or expired stub stored at `id` (even at the same revision),
   * and return a function that stops them. The offline wrapper subscribes to
   * the user's manifest only.
   */
  subscribe?(id: string, onChange: (env: StoredDocument) => void): () => void;
}

/** Page or caller configuration consumed by a registered adapter factory. */
export interface BackendConfig {
  type: string;
  [option: string]: unknown;
}

/** A factory can load its adapter on demand. It receives publishable config. */
export type BackendFactory = (
  config: BackendConfig,
) => Backend | Promise<Backend>;

/**
 * Options for `burrow()`. All three are required: Burrow never picks a backend
 * or creates an identity on its own (D-57).
 */
export interface BurrowConfig {
  /**
   * Names the app in key derivation. The same token gives each app its own
   * documents. Must match /^[a-z0-9-]{1,64}$/.
   */
  app: string;
  /**
   * Where the encrypted documents live: an adapter instance, or config for a
   * registered adapter type (for example `{ type: "firestore", ... }`).
   */
  backend: Backend | BackendConfig;
  /**
   * The storage token: from `generateToken()`, from `passkeyToken().get()`,
   * or kept by the app. Burrow holds only the keys derived from it, in memory.
   */
  token: string;
}

export type StorageChanges = Record<
  string,
  { oldValue?: unknown; newValue?: unknown }
>;
export interface ChangedEvent {
  changes: StorageChanges;
  /**
   * `"local"` for writes on this device (any tab), `"remote"` for changes
   * learned from the store.
   */
  source: "local" | "remote";
}

export type GetKeys =
  null | undefined | string | string[] | Record<string, unknown>;

/**
 * The async storage interface that `burrow()` and `offline()` both return, so
 * either can be used where the other is expected. The argument shapes are
 * those of chrome.storage's StorageArea (D-57). Reference: docs/api.md.
 */
export interface BurrowStorage {
  /**
   * Read all keys (no argument or null), one key, a list of keys, or an object
   * whose values are defaults for missing keys. Returns copies.
   */
  get(keys?: GetKeys): Promise<Record<string, unknown>>;
  /**
   * Write JSON values. Validates every key first, so an invalid batch writes
   * nothing: non-JSON values reject with TypeError, oversized items with
   * `item-too-large`.
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
   * Drop the keys held in memory and stop all work. Later calls reject
   * `closed`. Nothing on disk changes.
   */
  close(): void;
}

export type Status = "idle" | "syncing" | "offline" | "error";

export interface StatusEvent {
  status: Status;
  error?: BurrowError;
}

/**
 * The store returned by `offline()` from `burrow-storage/offline`: the same
 * interface, backed by a plaintext copy on this device (D-57). Reads and writes
 * go to the store when it answers and to the local copy when it does not;
 * they never reject for remote reasons (API-3, API-6).
 */
export interface OfflineStorage extends BurrowStorage {
  /**
   * Fires after writes on this device (`source: "local"`, any tab) and when
   * changes from the store reach the local copy (`"remote"`).
   */
  readonly onChanged: BurrowEvent<ChangedEvent>;
  /**
   * "idle", "syncing", "offline" (network or quota) or "error" (decrypt-failed,
   * expired, conflict, item-too-large).
   */
  readonly status: Status;
  /** Fires on every change of status or error. */
  readonly onStatus: BurrowEvent<StatusEvent>;
  /**
   * Push unsynced writes and refresh the local copy. Rejects with the error if
   * the store cannot be reached.
   */
  syncNow(): Promise<void>;
  /**
   * Delete this token's local copy on this device and close. Rejects
   * `would-orphan` while writes are unsynced, unless `discardLocal` is true.
   */
  forget(options?: { discardLocal?: boolean }): Promise<void>;
}
