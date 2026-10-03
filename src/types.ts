import type { BurrowError } from "./errors.js";
import type { BurrowEvent } from "./events.js";

/** Every stored document — manifest, item, keyslot — has this shape (§7). */
export interface Envelope {
  v: 1;
  /** 12 bytes, base64url (16 chars), fresh per write. */
  iv: string;
  /** base64url AES-256-GCM(key, iv, plaintext, aad = id || app || String(rev)). */
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
  /** Merge tie-break: hash of the serialised value (DECISIONS.md D-5). */
  h?: string;
}

/** Plaintext of an item document (id = docId(key)). */
export interface Item {
  v: 1;
  key: string;
  /** Any JSON value; null after deletion (documents are never removed, FS-6). */
  value: unknown;
  ts: number;
  deleted?: true;
}

export interface BackendCapabilities {
  /** Enforces the tok/next chain server-side (ENC-7). */
  writeAuth: boolean;
  /** Can push changes for one document id. */
  subscribe: boolean;
  /** put() survives page unload. */
  keepalive: boolean;
  maxEnvelopeBytes: number;
}

/** The only swappable seam (§9). Stores opaque envelopes at opaque ids. */
export interface Backend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  /** null = not found. */
  get(id: string): Promise<Envelope | null>;
  getMany?(ids: string[]): Promise<(Envelope | null)[]>;
  /**
   * expectedRev null = create (must not exist); otherwise must equal the stored rev.
   * Rejects BackendError("conflict" | "unauthorized" | "too-large" | "quota" | "network").
   */
  put(id: string, env: Envelope, expectedRev: number | null, opts?: { keepalive?: boolean }): Promise<void>;
  subscribe?(id: string, onChange: (env: Envelope) => void): () => void;
}

/** Small per-device string store for providers, e.g. a cached credential id (KP-9). */
export interface ProviderStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
}

export interface EnrolContext {
  app: string;
  rootSecret: Uint8Array;
  /** The configured backend, for providers that store a keyslot (DECISIONS.md D-7). */
  backend: Backend;
  store?: ProviderStore;
}

export interface RecoverContext {
  app: string;
  interactive: boolean;
  input?: string;
  backend: Backend;
  store?: ProviderStore;
}

/** An unlock method: carries the root secret to another device (§6). */
export interface KeyProvider {
  readonly id: string;
  available(): Promise<boolean>;
  enrol(ctx: EnrolContext): Promise<void>;
  /** null = declined or not possible right now. */
  recover(ctx: RecoverContext): Promise<Uint8Array | null>;
}

export interface BurrowConfig {
  /** /^[a-z0-9-]{1,64}$/ */
  app: string;
  backend?: Backend;
  keyProvider?: KeyProvider | KeyProvider[];
  cache?: "indexeddb" | "memory";
  rememberDevice?: boolean;
  syncIntervalMs?: number;
  debounceMs?: number;
  maxItemBytes?: number;
  debug?: boolean;
}

export type Status = "idle" | "syncing" | "offline" | "error";

/**
 * How this device got its storage token (the root secret): generated here on first use (KP-1),
 * entered as a code (pasted or typed), opened from a `#burrow=` link (KP-13), recovered from a
 * passkey, or from a custom provider (its id). "unknown" for tokens stored before this was recorded.
 */
export type TokenSource = "generated" | "code" | "link" | "passkey" | "unknown" | (string & {});

export interface TokenInfo {
  source: TokenSource;
  /** True when the token was loaded from this browser's storage rather than obtained this page load. */
  remembered: boolean;
  /** When this device obtained the token (ms), if known. */
  since: number | null;
}
export type Protection = "none" | "passkey" | "code" | (string & {});

export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
export interface ChangedEvent { changes: StorageChanges; source: "local" | "remote" }
export interface StatusEvent { status: Status; error?: BurrowError }

export interface Inspection {
  status: Status;
  tokenSource: TokenSource;
  protection: Protection;
  manifestRev: number | null;
  dirtyKeys: number;
  lastSyncAt: number | null;
  backend: string;
  provider: string | null;
}

export type GetKeys = null | undefined | string | string[] | Record<string, unknown>;

/** chrome.storage.StorageArea-shaped primary API (§5). */
export interface BurrowArea {
  get(keys?: GetKeys, opts?: { fresh?: boolean }): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  getBytesInUse(keys?: null | string | string[]): Promise<number>;
  readonly onChanged: BurrowEvent<ChangedEvent>;

  readonly status: Status;
  readonly protection: Protection;
  /** Where the token in use came from. Changes on link(); onToken fires then. */
  readonly token: TokenInfo;
  readonly onToken: BurrowEvent<TokenInfo>;
  readonly onStatus: BurrowEvent<StatusEvent>;
  readonly onUnprotected: BurrowEvent<void>;
  protect(providerId?: string): Promise<void>;
  link(options?: { provider?: string; code?: string; discardLocal?: boolean }): Promise<void>;
  unlink(options?: { discardLocal?: boolean }): Promise<void>;
  syncNow(): Promise<void>;
  exportCode(): Promise<string>;
  exportJSON(): Promise<string>;
  importJSON(json: string): Promise<void>;
  inspect(): Inspection;
  readonly storage: Storage;
}
