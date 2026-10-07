// SYNC-10..13 property tests: convergence, tombstones and clock skew over random op sequences.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core.js";
import {
  type Versioned,
  TOMBSTONE_TTL_MS,
  compare,
  mergeDirectories,
  nextTs,
} from "../../src/sync/merge.js";
import { World } from "../support/devices.js";

afterEach(() => vi.restoreAllMocks());

const version = fc
  .record({
    ts: fc.integer({ min: 0, max: 20 }),
    h: fc.constantFrom("0a", "0b", "ff"),
    deleted: fc.option(fc.constant(true as const), { nil: undefined }),
  })
  .map((v) =>
    v.deleted ? { ts: v.ts, deleted: true as const } : { ts: v.ts, h: v.h },
  ) as fc.Arbitrary<Versioned>;
const dir = fc.dictionary(fc.constantFrom("a", "b", "c", "d"), version);
const NOW = 1_000_000;

describe("merge laws (pure)", () => {
  it("compare is a total order: antisymmetric and transitive", () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0);
        if (compare(a, b) >= 0 && compare(b, c) >= 0)
          expect(compare(a, c)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("mergeDirectories is commutative, associative and idempotent", () => {
    fc.assert(
      fc.property(dir, dir, dir, (a, b, c) => {
        expect(mergeDirectories(a, b, NOW)).toEqual(
          mergeDirectories(b, a, NOW),
        );
        expect(mergeDirectories(mergeDirectories(a, b, NOW), c, NOW)).toEqual(
          mergeDirectories(a, mergeDirectories(b, c, NOW), NOW),
        );
        expect(mergeDirectories(a, a, NOW)).toEqual(
          mergeDirectories(a, {}, NOW),
        );
      }),
    );
  });

  it("the merged entry per key is the maximum of the inputs", () => {
    fc.assert(
      fc.property(dir, dir, (a, b) => {
        const m = mergeDirectories(a, b, NOW);
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          for (const src of [a[k], b[k]])
            if (src) expect(compare(m[k]!, src)).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("SYNC-10 tombstones are kept for 30 days, then pruned", () => {
    const t = { ts: NOW, deleted: true as const };
    expect(mergeDirectories({ k: t }, {}, NOW + TOMBSTONE_TTL_MS)).toEqual({
      k: t,
    });
    expect(mergeDirectories({ k: t }, {}, NOW + TOMBSTONE_TTL_MS + 1)).toEqual(
      {},
    );
  });

  it("SYNC-11 nextTs never goes below the previous write or the newest remote ts", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.option(fc.nat()),
        fc.option(fc.nat()),
        (now, prev, remote) => {
          const ts = nextTs(now, prev ?? undefined, remote ?? undefined);
          expect(ts).toBeGreaterThanOrEqual(now);
          if (prev !== null) expect(ts).toBeGreaterThan(prev);
          if (remote !== null) expect(ts).toBeGreaterThan(remote);
        },
      ),
    );
  });
});

type Op =
  | { t: "set"; dev: number; key: string; value: number }
  | { t: "remove"; dev: number; key: string }
  | { t: "sync"; dev: number }
  | { t: "syncBoth"; a: number; b: number }
  | { t: "offline"; dev: number; on: boolean }
  | { t: "wait"; ms: number };

const KEYS = ["k1", "k2", "k3"];
const op = (devices: number): fc.Arbitrary<Op> =>
  fc.oneof(
    {
      weight: 5,
      arbitrary: fc.record({
        t: fc.constant("set" as const),
        dev: fc.nat(devices - 1),
        key: fc.constantFrom(...KEYS),
        value: fc.integer({ min: 0, max: 99 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        t: fc.constant("remove" as const),
        dev: fc.nat(devices - 1),
        key: fc.constantFrom(...KEYS),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        t: fc.constant("sync" as const),
        dev: fc.nat(devices - 1),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        t: fc.constant("syncBoth" as const),
        a: fc.nat(devices - 1),
        b: fc.nat(devices - 1),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        t: fc.constant("offline" as const),
        dev: fc.nat(devices - 1),
        on: fc.boolean(),
      }),
    },
  );

async function runScenario(ops: Op[], skews: number[]) {
  const world = new World();
  let clock = 1_700_000_000_000;
  let skew = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock + skew);
  try {
    const devs = skews.map(() => world.device({ cache: "memory" }));
    const areas: Core[] = [];
    for (const d of devs) areas.push(await d.open({ debounceMs: 1e9 }));
    const code = await areas[0]!.exportCode();
    for (const a of areas.slice(1)) await a.link({ code });
    const lastOp = new Map<
      string,
      { t: "set"; value: number } | { t: "remove" }
    >();
    for (const o of ops) {
      clock += 1000;
      if (o.t === "set" || o.t === "remove") {
        skew = skews[o.dev]!;
        if (o.t === "set") {
          await areas[o.dev]!.set({ [o.key]: o.value });
          lastOp.set(o.key, { t: "set", value: o.value });
        } else {
          // Like chrome.storage, removing a key this device cannot see is a no-op.
          const visible = o.key in (await areas[o.dev]!.get(o.key));
          await areas[o.dev]!.remove(o.key);
          if (visible) lastOp.set(o.key, { t: "remove" });
        }
        skew = 0;
      } else if (o.t === "wait") {
        clock += o.ms;
      } else if (o.t === "sync") {
        await areas[o.dev]!.syncNow().catch(() => {});
      } else if (o.t === "syncBoth") {
        await Promise.all([
          areas[o.a]!.syncNow().catch(() => {}),
          areas[o.b]!.syncNow().catch(() => {}),
        ]);
      } else {
        devs[o.dev]!.backend.failWith = o.on ? "network" : null;
      }
    }
    for (const d of devs) d.backend.failWith = null;
    // Two full rounds: everyone pushes, then everyone pulls the result.
    for (let round = 0; round < 2; round++)
      for (const a of areas) await a.syncNow();
    const states = await Promise.all(areas.map((a) => a.get()));
    return {
      states,
      lastOp,
      dirty: areas.map((a) => a.inspect().dirtyKeys),
      elapsed: clock - 1_700_000_000_000,
    };
  } finally {
    world.close();
    vi.restoreAllMocks();
  }
}

describe("multi-device convergence (MemoryBackend)", () => {
  it("with synchronised clocks every device converges on the last write per key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(op(3), { minLength: 1, maxLength: 25 }),
        async (ops) => {
          const { states, lastOp, dirty } = await runScenario(ops, [0, 0, 0]);
          expect(dirty).toEqual([0, 0, 0]);
          for (const s of states) expect(s).toEqual(states[0]);
          const expected: Record<string, number> = {};
          for (const [k, o] of lastOp) if (o.t === "set") expected[k] = o.value;
          expect(states[0]).toEqual(expected);
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 40) },
    );
  }, 300_000);

  it("with skewed clocks every device still converges, and only on written values", async () => {
    const skew = fc.integer({ min: -3_600_000, max: 3_600_000 });
    await fc.assert(
      fc.asyncProperty(
        fc.array(op(3), { minLength: 1, maxLength: 25 }),
        fc.tuple(skew, skew, skew),
        async (ops, skews) => {
          const { states, dirty } = await runScenario(ops, skews);
          expect(dirty).toEqual([0, 0, 0]);
          for (const s of states) expect(s).toEqual(states[0]);
          for (const [k, v] of Object.entries(states[0]!)) {
            expect(
              ops.some((o) => o.t === "set" && o.key === k && o.value === v),
            ).toBe(true);
          }
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 40) },
    );
  }, 300_000);

  it("SYNC-10 across tombstone expiry (clock spans > 30 days) devices converge and deletes stay deleted", async () => {
    const DAY = 86_400_000;
    // Random waits of up to 8 days between operations, plus one jump past the 30-day tombstone TTL
    // somewhere in the middle, so tombstones written before it are pruned from the manifest while
    // devices that were offline (or simply did not sync) still hold the deleted keys.
    const wait = fc.record({
      t: fc.constant("wait" as const),
      ms: fc.integer({ min: 1, max: 8 * DAY }),
    });
    const opOrWait = fc.oneof(
      { weight: 6, arbitrary: op(3) },
      { weight: 1, arbitrary: wait },
    );
    const ops = fc
      .tuple(
        fc.array(opOrWait, { minLength: 1, maxLength: 15 }),
        fc.integer({
          min: TOMBSTONE_TTL_MS + 1,
          max: TOMBSTONE_TTL_MS + 10 * DAY,
        }),
        fc.array(opOrWait, { minLength: 1, maxLength: 15 }),
      )
      .map(([before, jump, after]): Op[] => [
        ...before,
        { t: "wait", ms: jump },
        ...after,
      ]);
    await fc.assert(
      fc.asyncProperty(ops, async (ops) => {
        const { states, lastOp, dirty, elapsed } = await runScenario(
          ops,
          [0, 0, 0],
        );
        expect(elapsed).toBeGreaterThan(TOMBSTONE_TTL_MS);
        expect(dirty).toEqual([0, 0, 0]);
        for (const s of states) expect(s).toEqual(states[0]);
        // Last write per key wins; a key whose last operation was a remove is absent everywhere.
        const expected: Record<string, number> = {};
        for (const [k, o] of lastOp) if (o.t === "set") expected[k] = o.value;
        expect(states[0]).toEqual(expected);
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 40) },
    );
  }, 300_000);

  it("SYNC-10 a device offline for more than 30 days does not resurrect a key deleted elsewhere", async () => {
    const DAY = 86_400_000;
    // C holds k (synced) and goes offline; A deletes k; 31+ days later A syncs again (pruning the
    // tombstone from the manifest) and only then does C come back. Variants: C also wrote k offline
    // before the delete (older than the delete: must lose) or after the gap (newer: must win).
    for (const cWrites of ["none", "before", "after"] as const) {
      const ops: Op[] = [
        { t: "set", dev: 0, key: "k1", value: 1 },
        { t: "set", dev: 0, key: "k2", value: 2 },
        { t: "sync", dev: 0 },
        { t: "sync", dev: 1 },
        { t: "sync", dev: 2 },
        { t: "offline", dev: 2, on: true },
        ...(cWrites === "before"
          ? [{ t: "set", dev: 2, key: "k1", value: 7 } as Op]
          : []),
        { t: "remove", dev: 0, key: "k1" },
        { t: "sync", dev: 0 },
        { t: "sync", dev: 1 },
        { t: "wait", ms: 31 * DAY },
        { t: "set", dev: 1, key: "k3", value: 3 },
        { t: "sync", dev: 1 },
        { t: "sync", dev: 0 },
        ...(cWrites === "after"
          ? [{ t: "set", dev: 2, key: "k1", value: 9 } as Op]
          : []),
        { t: "offline", dev: 2, on: false },
        { t: "sync", dev: 2 },
      ];
      const { states } = await runScenario(ops, [0, 0, 0]);
      const want =
        cWrites === "after" ? { k1: 9, k2: 2, k3: 3 } : { k2: 2, k3: 3 };
      for (const s of states) expect(s, `C wrote ${cWrites}`).toEqual(want);
    }
  }, 120_000);

  it("two devices writing the same key at the same millisecond converge (tie-break)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        async (x, y) => {
          const { states } = await runScenario(
            [
              { t: "offline", dev: 0, on: true },
              { t: "offline", dev: 1, on: true },
              { t: "set", dev: 0, key: "k1", value: x },
              { t: "set", dev: 1, key: "k1", value: y },
            ],
            [0, -1000],
          ); // the second write lands on the same clock reading as the first
          expect(states[0]).toEqual(states[1]);
          expect([x, y]).toContain((states[0] as Record<string, number>).k1);
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});
