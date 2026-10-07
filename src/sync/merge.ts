// Conflict resolution between devices: per-key last-writer-wins, with deletes
// kept as tombstones.
//
// Every key carries a version `{ ts, h?, deleted? }`. When two devices
// disagree about a key, the version that sorts higher under `compare()` wins,
// everywhere, so all replicas converge on the same value without coordinating.
// The rules, with their ids in docs/history/requirements.md:
//
//   SYNC-10  Greater `ts` wins. Equal `ts` is broken by a hash of the value
//            (see `compare`, docs/decisions.md D-5). A delete is not an
//            absence: it is a tombstone entry that competes like a value and
//            is kept for 30 days, so a device that was offline and still holds
//            the old value cannot bring it back.
//   SYNC-11  Clocks between devices drift. A local write is stamped above the
//            version it replaces and above the greatest `ts` seen in any pull
//            (see `nextTs`), so it is not lost to a remote entry from a fast
//            clock.
//   SYNC-12  `remove()` / `clear()` write tombstones (the store side of this
//            lives in core.ts).
//
// Design detail: docs/architecture.md §7. Everything here is pure (no I/O,
// clock passed in) so it can be property-tested for commutativity and
// convergence.
import { hex, sha256, utf8 } from "../bytes.js";

/** The version of one key: what the merge compares. Stored in the manifest. */
export interface Versioned {
  /** Logical timestamp (ms) of the write; see `nextTs`. */
  ts: number;
  /**
   * Tie-break hash of the value (`valueHash`); absent on tombstones and on
   * entries not hashed yet.
   */
  h?: string;
  /** Present when the key was removed: a tombstone. */
  deleted?: true;
}

/**
 * Stand-in hash for tombstones in `compare`. "~" sorts above every hex digit,
 * so on an exact `ts` tie a delete beats any value (docs/decisions.md D-5):
 * replaying a delete is then idempotent.
 */
export const TOMBSTONE_H = "~";
/** How long a tombstone stays in the manifest before it is pruned (SYNC-10). */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tie-break hash of a value: hex SHA-256 of `JSON.stringify(value)`, first 16
 * chars. Only decides between two writes with the same `ts`. It is a hash
 * rather than the value itself because the manifest, which drives the merge,
 * holds no values (docs/decisions.md D-5).
 */
export async function valueHash(value: unknown): Promise<string> {
  return hex(await sha256(utf8(JSON.stringify(value)))).slice(0, 16);
}

/**
 * Total order on versions: by `ts`, then tombstone above value, then by hash.
 * Positive when `a` wins, negative when `b` wins, 0 when they are the same
 * version. Every device applies the same order, so they all pick the same
 * winner.
 */
export function compare(a: Versioned, b: Versioned): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const ha = a.deleted ? TOMBSTONE_H : (a.h ?? "");
  const hb = b.deleted ? TOMBSTONE_H : (b.h ?? "");
  return ha < hb ? -1 : ha > hb ? 1 : 0;
}

/**
 * Strips a version down to the fields the manifest stores (drops `h` from
 * tombstones, and any extra properties).
 */
export const entryOf = (v: Versioned): Versioned =>
  v.deleted
    ? { ts: v.ts, deleted: true }
    : v.h === undefined
      ? { ts: v.ts }
      : { ts: v.ts, h: v.h };

/**
 * Merges two key directories (key → version maps, as held in the manifest),
 * keeping the winner per key. Tombstones older than `TOMBSTONE_TTL_MS` relative
 * to `now` are dropped from the result.
 */
export function mergeDirectories(
  a: Record<string, Versioned>,
  b: Record<string, Versioned>,
  now: number,
): Record<string, Versioned> {
  const out: Record<string, Versioned> = {};
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src)) {
      const cur = out[k];
      if (!cur || compare(v, cur) > 0) out[k] = entryOf(v);
    }
  }
  for (const [k, v] of Object.entries(out))
    if (v.deleted && now - v.ts > TOMBSTONE_TTL_MS) delete out[k];
  return out;
}

/**
 * Timestamp for a new local write (SYNC-11 clock-skew guard): the wall clock,
 * but never at or below the version being replaced (`previous`) or the
 * greatest `ts` seen in any pull (`maxRemoteTs`). Without this, a device whose
 * clock runs behind would write versions that lose to entries it has already
 * seen, and its edits would vanish on the next merge.
 */
export function nextTs(
  now: number,
  previous: number | undefined,
  maxRemoteTs: number | undefined,
): number {
  return Math.max(
    Math.floor(now),
    (previous ?? -1) + 1,
    (maxRemoteTs ?? -1) + 1,
  );
}
