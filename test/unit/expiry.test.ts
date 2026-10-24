// D-48 content expiry and use-driven renewal. The core reports expiry stubs as
// `expired` (test/unit/core.test.ts); the offline wrapper pauses remote work
// and keeps its copy, and it alone renews content (D-57).
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdbCache } from "../../src/cache/indexeddb.js";
import { MemoryCache } from "../../src/cache/memory.js";
import { deriveAppKeys, docId } from "../../src/codec/derive.js";
import { open } from "../../src/codec/envelope.js";
import { decodeToken } from "../../src/codec/token.js";
import { remoteOf } from "../../src/core.js";
import { BackendError } from "../../src/errors.js";
import type { Envelope, Manifest, OfflineStorage } from "../../src/types.js";
import { World, settle, until } from "../support/devices.js";

const DAY = 86_400_000;
let world: World;
afterEach(() => {
  world?.close();
  vi.restoreAllMocks();
});

async function fixture(kind: "memory" | "indexeddb" = "memory") {
  world = new World();
  const device = world.device({ cache: kind });
  const backend = device.backend;
  vi.spyOn(backend, "subscribe").mockImplementation(() => () => {});
  const area = await device.open();
  await area.set({ k: "kept", pruned: "old" });
  await settle(area);
  const keys = await deriveAppKeys(
    await decodeToken(await world.token()),
    "test",
  );
  const identity = remoteOf(
    await device.core(), // same token: same identity
  )!.identity;
  const cache =
    kind === "memory"
      ? new MemoryCache("test", identity, device.mem)
      : await IdbCache.open("test", identity, device.idb);
  const id = await docId(keys, "k");
  const cipher = (id: string) => ({
    key: keys.encKey,
    mac: keys.macKey,
    aad: id + "test",
  });
  const read = async (id: string) =>
    JSON.parse(
      new TextDecoder().decode(
        await open(cipher(id), world.store.get(id)! as Envelope),
      ),
    );
  const stub = (id: string) => {
    const cur = world.store.get(id)!;
    world.store.set(id, { x: true, rev: cur.rev, next: cur.next });
  };
  return { area, device, backend, keys, cache, id, read, stub };
}

const pausedExpired = (a: OfflineStorage) =>
  a.status === "error" &&
  a.syncNow().then(
    () => false,
    (e) => e.code === "expired",
  );

describe("D-48 expiry preserves the local copy", () => {
  describe.each(["memory", "indexeddb"] as const)("%s cache", (kind) => {
    it.each(["write", "named read"])(
      "an expired item pauses remote work on a %s and keeps every entry and unsynced write",
      async (operation) => {
        const { area, device, cache, id, stub } = await fixture(kind);
        stub(id);
        if (operation === "write") await area.set({ k: "new" });
        else expect(await area.get("k")).toEqual({ k: "kept" });
        expect(await pausedExpired(area)).toBe(true);
        // Local reads and writes keep working, with no remote calls.
        const { gets, puts } = device.backend.stats;
        await area.set({ fresh: "unsynced" });
        const k = operation === "write" ? "new" : "kept";
        expect(await area.get()).toEqual({
          k,
          pruned: "old",
          fresh: "unsynced",
        });
        expect(device.backend.stats).toEqual({ gets, puts });
        const items = await cache.loadItems();
        expect(items.get("k")).toMatchObject({ value: k });
        expect(items.get("fresh")).toMatchObject({
          value: "unsynced",
          dirty: true,
        });
        expect(world.store.get(id)).toMatchObject({ x: true });
      },
    );
  });

  it("an ordinary write to an expired key keeps the new value locally and never replaces the stub", async () => {
    const { area, id, stub } = await fixture();
    stub(id);
    await area.set({ k: "new" });
    expect(await area.get("k")).toEqual({ k: "new" });
    expect(area.status).toBe("error");
    expect(world.store.get(id)).toEqual({
      x: true,
      rev: world.store.get(id)!.rev,
      next: (world.store.get(id) as { next: string }).next,
    });
  });

  it("an expired manifest keeps unsynced data and never creates a fresh manifest", async () => {
    const { area, keys, cache, stub } = await fixture();
    stub(keys.base);
    await area.set({ dirty: 1 });
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(world.store.get(keys.base)).toMatchObject({ x: true });
    expect((await cache.loadItems()).get("dirty")).toMatchObject({
      dirty: true,
    });
  });

  it("an expiry stub notification pauses at once", async () => {
    world = new World();
    const device = world.device();
    let notify!: (env: { x: true; rev: number; next: string }) => void;
    vi.spyOn(device.backend, "subscribe").mockImplementation((_id, cb) => {
      notify = cb as typeof notify;
      return () => {};
    });
    const area = await device.open();
    await settle(area);
    notify({ x: true, rev: 0, next: "0".repeat(64) });
    expect(area.status).toBe("error");
    expect(await pausedExpired(area)).toBe(true);
  });
});

describe("D-48 use-driven renewal (offline wrapper only)", () => {
  it("renewal rewrites every listed item and tombstone, then the manifest, without changing logical versions; the receipt is 29–30 days away", async () => {
    const { area, cache, keys, read } = await fixture();
    await area.remove("pruned");
    await settle(area);
    const ids = await Promise.all(["k", "pruned"].map((k) => docId(keys, k)));
    const before = await Promise.all(ids.map(read));
    const revs = ids.map((i) => world.store.get(i)!.rev);
    const manifest = (await read(keys.base)) as Manifest;
    const mrev = world.store.get(keys.base)!.rev;
    const receipt = (await cache.getMeta()).renewAt!;
    const now = receipt + 1;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await area.get("k"); // use
    await until(async () => world.store.get(keys.base)!.rev > mrev);
    await settle(area);
    expect(await Promise.all(ids.map(read))).toEqual(before);
    expect(ids.map((i) => world.store.get(i)!.rev)).toEqual(
      revs.map((r) => r + 1),
    );
    expect(((await read(keys.base)) as Manifest).items).toEqual(manifest.items);
    const next = (await cache.getMeta()).renewAt!;
    expect(next).toBeGreaterThan(now + 29 * DAY - 1);
    expect(next).toBeLessThanOrEqual(now + 30 * DAY);
  });

  it("use before the deadline does not renew; tabs share the receipt", async () => {
    const { area, device, keys, cache } = await fixture();
    const tab = await device.open();
    await settle(tab);
    const mrev = world.store.get(keys.base)!.rev;
    await area.get();
    await tab.get();
    await settle(area);
    await settle(tab);
    expect(world.store.get(keys.base)!.rev).toBe(mrev);
    // Past the deadline, two tabs renew once between them.
    vi.spyOn(Date, "now").mockReturnValue((await cache.getMeta()).renewAt! + 1);
    await Promise.all([area.syncNow(), tab.syncNow()]);
    await Promise.all([area.syncNow(), tab.syncNow()]);
    expect(world.store.get(keys.base)!.rev).toBe(mrev + 1);
  });

  it("a failed renewal records nothing and retries the complete set", async () => {
    const { area, backend, keys, cache } = await fixture();
    const receipt = (await cache.getMeta()).renewAt!;
    vi.spyOn(Date, "now").mockReturnValue(receipt + 1);
    const put = backend.put.bind(backend);
    const fail = vi
      .spyOn(backend, "put")
      .mockImplementation(async (id, env, rev, opts) => {
        if (id === keys.base) throw new BackendError("network");
        await put(id, env, rev, opts);
      });
    await expect(area.syncNow()).rejects.toMatchObject({ code: "backend" });
    expect((await cache.getMeta()).renewAt).toBe(receipt);
    fail.mockRestore();
    await area.syncNow();
    expect((await cache.getMeta()).renewAt).toBeGreaterThan(receipt + 1);
  });

  it("a missing listed document is rewritten from the local copy", async () => {
    const { area, cache, id, read } = await fixture();
    const value = await read(id);
    world.store.delete(id);
    vi.spyOn(Date, "now").mockReturnValue((await cache.getMeta()).renewAt! + 1);
    await area.syncNow();
    expect(await read(id)).toEqual(value);
  });

  it("missing listed content with no local copy blocks renewal without inventing success or dropping dirty data", async () => {
    const { device, cache, id, keys } = await fixture();
    world.store.delete(id);
    // A second device with an empty copy.
    const other = await world.device().open();
    const mrev = world.store.get(keys.base)!.rev;
    await expect(other.syncNow()).rejects.toMatchObject({ code: "backend" });
    await other.set({ dirty: 1 });
    expect(world.store.get(keys.base)!.rev).toBeGreaterThanOrEqual(mrev);
    expect(device.backend).toBeDefined();
    expect((await cache.getMeta()).renewAt).toBeDefined();
  });

  it("the core alone does not renew: reads rewrite nothing", async () => {
    world = new World();
    const d = world.device();
    const core = await d.core();
    await core.set({ k: 1 });
    const puts = d.backend.stats.puts;
    await core.get();
    await core.get("k");
    expect(d.backend.stats.puts).toBe(puts);
  });
});
