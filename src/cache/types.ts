/**
 * SYNC-2: one item, as the offline wrapper keeps it and as the core reports
 * it. `rev` is the last known revision of its remote document.
 */
export interface CachedItem {
  value?: unknown;
  ts: number;
  /** Merge tie-break hash of the serialised value (docs/decisions.md D-5). */
  h?: string;
  deleted?: true;
  /** Written on this device and not yet in the store (SYNC-9). */
  dirty?: true;
  rev?: number;
}

/** SYNC-3: per-identity sync state of the local copy. */
export interface AppMeta {
  /** Greatest remote ts seen, for clock-skew correction (SYNC-11). */
  maxRemoteTs?: number;
  lastSyncAt?: number | null;
  /** Next client-use renewal deadline on this device, at most 30 days away. */
  renewAt?: number;
}

/** The previous and the new entry of each key an update wrote. */
export type Updated = Map<string, [CachedItem | undefined, CachedItem | null]>;

/**
 * The offline wrapper's local copy for one app and one token (D-57). It holds
 * plaintext items and sync state; never a token or a key.
 */
export interface Cache {
  readonly kind: "indexeddb" | "memory";
  loadItems(): Promise<Map<string, CachedItem>>;
  getItems(keys: string[]): Promise<Map<string, CachedItem>>;
  /**
   * Atomic read-modify-write of the given keys (one transaction), so a sync
   * never clobbers a newer write made meanwhile by another tab. `fn` returns
   * the new entry, null to delete, or undefined to leave it. Resolves with the
   * keys it wrote, before and after.
   */
  updateItems(
    keys: string[],
    fn: (
      key: string,
      cur: CachedItem | undefined,
    ) => CachedItem | null | undefined,
  ): Promise<Updated>;
  getMeta(): Promise<AppMeta>;
  setMeta(patch: Partial<AppMeta>): Promise<void>;
  /** Delete this local copy from the device. */
  destroy(): Promise<void>;
  close(): void;
}
