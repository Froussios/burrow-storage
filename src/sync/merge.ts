// SYNC-10..12: per-key last-writer-wins with tombstones. Pure functions; property-tested.
import { hex, sha256, utf8 } from "../bytes.js";

export interface Versioned {
  ts: number;
  h?: string;
  deleted?: true;
}

/** Tombstones sort above every value hash, so a delete wins an exact-ts tie. */
export const TOMBSTONE_H = "~";
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Tie-break hash of a value: hex SHA-256 of its JSON serialisation, first 16 chars (docs/decisions.md D-5). */
export async function valueHash(value: unknown): Promise<string> {
  return hex(await sha256(utf8(JSON.stringify(value)))).slice(0, 16);
}

/** Order on (ts, h). Positive when a wins. Both sides compute the same order, so replicas converge. */
export function compare(a: Versioned, b: Versioned): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const ha = a.deleted ? TOMBSTONE_H : a.h ?? "";
  const hb = b.deleted ? TOMBSTONE_H : b.h ?? "";
  return ha < hb ? -1 : ha > hb ? 1 : 0;
}

/** Entry form stored in the manifest. */
export const entryOf = (v: Versioned): Versioned =>
  v.deleted ? { ts: v.ts, deleted: true } : v.h === undefined ? { ts: v.ts } : { ts: v.ts, h: v.h };

/** Merge two key directories; the winner per key is kept. Expired tombstones are pruned. */
export function mergeDirectories(a: Record<string, Versioned>, b: Record<string, Versioned>, now: number): Record<string, Versioned> {
  const out: Record<string, Versioned> = {};
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src)) {
      const cur = out[k];
      if (!cur || compare(v, cur) > 0) out[k] = entryOf(v);
    }
  }
  for (const [k, v] of Object.entries(out)) if (v.deleted && now - v.ts > TOMBSTONE_TTL_MS) delete out[k];
  return out;
}

/** SYNC-11: a local write never carries a ts below what it is replacing or what we saw remotely. */
export function nextTs(now: number, previous: number | undefined, maxRemoteTs: number | undefined): number {
  return Math.max(Math.floor(now), (previous ?? -1) + 1, (maxRemoteTs ?? -1) + 1);
}
