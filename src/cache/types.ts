/**
 * SYNC-2: one cached item. `rev` is the last known revision of its remote
 * document.
 */
export interface CachedItem {
  value?: unknown;
  ts: number;
  /**
   * Merge tie-break hash of the serialised value (docs/decisions.md D-5);
   * filled lazily.
   */
  h?: string;
  deleted?: true;
  dirty?: true;
  rev?: number;
}

/** SYNC-3: per-app sync state. */
export interface AppMeta {
  /**
   * Fingerprint of the secret this cache belongs to (not an id;
   * docs/decisions.md D-8).
   */
  owner?: string;
  manifestRev?: number | null;
  /** Greatest remote ts seen, for clock-skew correction (SYNC-11). */
  maxRemoteTs?: number;
  lastSyncAt?: number | null;
  unprotectedFired?: boolean;
}

/**
 * Origin-wide device state: the root secret is shared by every app on the
 * origin (KP-4).
 */
export interface DeviceMeta {
  /** Root secret wrapped under `kw` (KP-2, ENC-10). */
  wrapped?: Uint8Array;
  /**
   * Non-extractable AES-KW key; IndexedDB stores the CryptoKey object itself.
   */
  kw?: CryptoKey;
  /** Which unlock method protects the current secret on this device. */
  protection?: string;
  /** How this device obtained the secret, and when (TokenInfo). */
  tokenSource?: string;
  tokenSince?: number;
  /**
   * Provider-owned values (KP-9: the passkey credential id), keyed "p:<name>".
   */
  [provider: `p:${string}`]: string | undefined;
}

export interface Cache {
  readonly kind: "indexeddb" | "memory";
  loadItems(): Promise<Map<string, CachedItem>>;
  /** Atomic batch write. `null` deletes the entry (tombstone pruning only). */
  putItems(entries: Iterable<[string, CachedItem | null]>): Promise<void>;
  /**
   * Atomic read-modify-write of the given keys (one transaction), so a sync
   * pass never clobbers a newer write made meanwhile by another tab. `fn`
   * returns the new entry, null to delete, or undefined to leave it. Resolves
   * with the entries as written.
   */
  updateItems(
    keys: string[],
    fn: (
      key: string,
      cur: CachedItem | undefined,
    ) => CachedItem | null | undefined,
  ): Promise<Map<string, CachedItem | null>>;
  clearItems(): Promise<void>;
  getMeta(): Promise<AppMeta>;
  setMeta(patch: Partial<AppMeta>): Promise<void>;
  getDevice(): Promise<DeviceMeta>;
  /** Keys set to undefined are removed. */
  setDevice(patch: Partial<DeviceMeta>): Promise<void>;
  close(): void;
}
