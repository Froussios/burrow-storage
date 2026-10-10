import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../src/backends/memory.js";
import { MemoryCache } from "../../src/cache/memory.js";
import { IdbCache } from "../../src/cache/indexeddb.js";
import { deriveAppKeys, docId } from "../../src/codec/derive.js";
import { open, seal } from "../../src/codec/envelope.js";
import { decodeToken } from "../../src/codec/token.js";
import { valueHash } from "../../src/sync/merge.js";
import { utf8 } from "../../src/bytes.js";
import { BackendError } from "../../src/errors.js";
import type { Envelope, Manifest, StoredDocument } from "../../src/types.js";
import { World, until } from "../support/devices.js";

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
  const area = await device.open({ debounceMs: 1e9 });
  await area.syncNow();
  await area.set({ k: "kept", pruned: "old" });
  await area.syncNow();
  const keys = await deriveAppKeys(
    await decodeToken(await area.exportToken()),
    "test",
  );
  const cache =
    kind === "memory"
      ? new MemoryCache("test", device.mem)
      : await IdbCache.open("test", device.idb);
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
  return { area, device, backend, keys, cache, id, cipher, read, stub };
}

describe("D-48 content expiry and use-driven renewal", () => {
  it("a cached-rev ordinary put cannot silently revive an independently expired item", async () => {
    const { area, backend, keys, id, stub, cache } = await fixture();
    stub(id);
    const manifest = structuredClone(world.store.get(keys.base));
    await area.set({ k: "unsynced" });
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(area.status).toBe("error");
    expect(await area.get()).toEqual({ k: "unsynced", pruned: "old" });
    expect((await cache.loadItems()).get("k")).toMatchObject({
      value: "unsynced",
      dirty: true,
    });
    expect(world.store.get(keys.base)).toEqual(manifest);
    const calls = backend.stats.gets;
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(backend.stats.gets).toBe(calls);
  });

  it.each([{ selected: "k" }, { selected: ["pruned", "k"] }])(
    "fresh reads of $selected pause without rejecting local reads or applying partial results",
    async ({ selected }) => {
      const { area, cache, id, stub } = await fixture();
      stub(id);
      const before = await cache.loadItems();
      const errors: string[] = [];
      area.onStatus.addListener((s) => {
        if (s.error) errors.push(s.error.code);
      });
      expect(await area.get(selected, { fresh: true })).toEqual(
        typeof selected === "string"
          ? { k: "kept" }
          : { pruned: "old", k: "kept" },
      );
      expect(errors).toContain("expired");
      expect(area.status).toBe("error");
      expect(await cache.loadItems()).toEqual(before);
    },
  );

  it("due renewal detects independently expired clean items before cache/prune/publication", async () => {
    const { area, keys, cache, id, stub } = await fixture();
    const receipt = (await cache.getMeta()).renewAt!;
    vi.spyOn(Date, "now").mockReturnValue(receipt + 1);
    stub(id);
    const before = await cache.loadItems();
    const manifest = structuredClone(world.store.get(keys.base));
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(await cache.loadItems()).toEqual(before);
    expect((await cache.getMeta()).renewAt).toBe(receipt);
    expect(world.store.get(keys.base)).toEqual(manifest);
  });

  it("an expired manifest preserves dirty data and never creates a fresh manifest", async () => {
    const { area, keys, stub, cache } = await fixture();
    await area.set({ local: 2 });
    const before = await cache.loadItems();
    stub(keys.base);
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(await cache.loadItems()).toEqual(before);
    expect(world.store.get(keys.base)).toMatchObject({ x: true });
    expect(await area.get()).toEqual({ k: "kept", pruned: "old", local: 2 });
  });

  it("a same-revision x notification pauses immediately", async () => {
    world = new World();
    const device = world.device({ cache: "memory" });
    let notify: ((env: StoredDocument) => void) | undefined;
    vi.spyOn(device.backend, "subscribe").mockImplementation((_id, cb) => {
      notify = cb;
      return () => {};
    });
    const area = await device.open({ debounceMs: 1e9 });
    await area.set({ k: 1 });
    await area.syncNow();
    const keys = await deriveAppKeys(
      await decodeToken(await area.exportToken()),
      "test",
    );
    const env = world.store.get(keys.base)!;
    notify!({ x: true, rev: env.rev, next: env.next });
    expect(area.inspect()).toMatchObject({
      status: "error",
      manifestRev: env.rev,
    });
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(await area.get()).toEqual({ k: 1 });
  });

  it.each(["memory", "indexeddb"] as const)(
    "%s cache: expiry after item writes preserves staged pulls, pruning candidates, dirty data and receipt",
    async (kind) => {
      const { area, backend, keys, cipher, read, cache, id, stub } =
        await fixture(kind);
      const m = (await read(keys.base)) as Manifest;
      delete m.items.pruned;
      m.items.k!.ts++;
      const item = await read(id);
      item.ts = m.items.k!.ts;
      item.value = "remote";
      const cur = world.store.get(id)!;
      world.store.set(
        id,
        await seal(
          cipher(id),
          id,
          cur.rev + 1,
          utf8(JSON.stringify(item)),
          Date.now(),
        ),
      );
      const menv = world.store.get(keys.base)!;
      world.store.set(
        keys.base,
        await seal(
          cipher(keys.base),
          keys.base,
          menv.rev + 1,
          utf8(JSON.stringify(m)),
          Date.now(),
        ),
      );
      await area.set({ dirty: "pending" });
      const before = await cache.loadItems();
      const receipt = (await cache.getMeta()).renewAt;
      const put = backend.put.bind(backend);
      vi.spyOn(backend, "put").mockImplementation(
        async (id, env, rev, options) => {
          await put(id, env, rev, options);
          if (id !== keys.base) stub(keys.base);
        },
      );
      await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
      expect(await cache.loadItems()).toEqual(before);
      expect((await cache.getMeta()).renewAt).toBe(receipt);
      expect(await area.get()).toEqual({
        k: "kept",
        pruned: "old",
        dirty: "pending",
      });
    },
  );

  it("renewal rewrites every listed live/deleted item before the manifest without changing logical payloads, then persists 29–30 day jitter", async () => {
    const { area, device, backend, keys, cache, read } = await fixture();
    await area.remove("pruned");
    await area.syncNow();
    const before = new Map<string, unknown>();
    for (const id of world.store.keys()) before.set(id, await read(id));
    const old = (await cache.getMeta()).renewAt!;
    let now = old + 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const order: string[] = [];
    const put = backend.put.bind(backend);
    vi.spyOn(backend, "put").mockImplementation(async (id, env, rev, opts) => {
      await put(id, env, rev, opts);
      order.push(id);
    });
    await area.get("k");
    await area.syncNow();
    expect(order).toHaveLength(3);
    expect(order.at(-1)).toBe(keys.base);
    for (const [id, payload] of before) expect(await read(id)).toEqual(payload);
    const receipt = (await cache.getMeta()).renewAt!;
    expect(receipt - now).toBeGreaterThanOrEqual(29 * DAY);
    expect(receipt - now).toBeLessThanOrEqual(30 * DAY);
    const puts = backend.stats.puts;
    await area.syncNow();
    expect(backend.stats.puts).toBe(puts);
    area.close();
    const reopened = await device.open({ debounceMs: 1e9 });
    await reopened.syncNow();
    expect(backend.stats.puts).toBe(puts);
    expect((await cache.getMeta()).renewAt).toBe(receipt);
    now = receipt + 1;
    await reopened.syncNow();
    expect(backend.stats.puts).toBe(puts + 3);
  });

  it("already-open tabs consult the shared per-device receipt under the sync lock", async () => {
    const { area, device, backend, cache } = await fixture();
    const tab = await device.open({ debounceMs: 1e9 });
    await tab.syncNow();
    vi.spyOn(Date, "now").mockReturnValue((await cache.getMeta()).renewAt! + 1);
    const puts = backend.stats.puts;
    await area.syncNow();
    expect(backend.stats.puts).toBe(puts + 3);
    await tab.syncNow();
    expect(backend.stats.puts).toBe(puts + 3);
  });

  it("observed expiry dominates a simultaneous item transport failure", async () => {
    const { area, backend, cache, keys, id } = await fixture();
    vi.spyOn(Date, "now").mockReturnValue((await cache.getMeta()).renewAt! + 1);
    const receipt = (await cache.getMeta()).renewAt;
    vi.spyOn(backend, "put").mockImplementation(async (target) => {
      if (target === keys.base) throw new Error("must not publish");
      throw new BackendError(target === id ? "network" : "expired");
    });
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(area.status).toBe("error");
    expect((await cache.getMeta()).renewAt).toBe(receipt);
    expect(await area.get()).toEqual({ k: "kept", pruned: "old" });
  });

  it("failed renewal records no success and retries the complete set", async () => {
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
    const before = await cache.loadItems();
    await expect(area.syncNow()).rejects.toMatchObject({ code: "backend" });
    expect((await cache.getMeta()).renewAt).toBe(receipt);
    expect(await cache.loadItems()).toEqual(before);
    fail.mockRestore();
    await area.syncNow();
    expect((await cache.getMeta()).renewAt).toBeGreaterThan(receipt + 1);
  });

  it.each(["memory", "indexeddb"] as const)(
    "%s cache: local and other-tab writes during renewal stay dirty until their own publication",
    async (kind) => {
      const { area, device, backend, keys, cache } = await fixture(kind);
      const tab = await device.open({ debounceMs: 1e9 });
      await tab.syncNow();
      vi.spyOn(Date, "now").mockReturnValue(
        (await cache.getMeta()).renewAt! + 1,
      );
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let waiting = false;
      const put = backend.put.bind(backend);
      vi.spyOn(backend, "put").mockImplementation(
        async (id, env, rev, opts) => {
          if (id !== keys.base && !waiting) {
            waiting = true;
            await gate;
          }
          await put(id, env, rev, opts);
        },
      );
      const syncing = area.syncNow();
      await until(() => waiting);
      area.storage.setItem("k", "new local");
      await tab.set({ pruned: "other tab" });
      release();
      await syncing;
      const items = await cache.loadItems();
      expect(items.get("k")).toMatchObject({ value: "new local", dirty: true });
      expect(items.get("pruned")).toMatchObject({
        value: "other tab",
        dirty: true,
      });
      await area.syncNow();
      expect(await area.get()).toEqual({ k: "new local", pruned: "other tab" });
      expect(area.inspect().dirtyKeys).toBe(0);
    },
  );

  it("a same-ts other-tab write is not marked clean by an older value's publication", async () => {
    const { area, device, backend, keys, cache, id } = await fixture();
    const env = device.env();
    // Keep this tab's mirror stale while it shares the cache.
    env.channel = () => null;
    const tab = await device.open({ debounceMs: 1e9 }, env);
    await tab.syncNow();
    const initial = (await cache.loadItems()).get("k")!.ts;
    vi.spyOn(Date, "now").mockReturnValue(initial + 1);
    await area.set({ k: "sent" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let waiting = false;
    const put = backend.put.bind(backend);
    vi.spyOn(backend, "put").mockImplementation(
      async (target, envelope, rev, opts) => {
        if (target === id) {
          waiting = true;
          await gate;
        }
        await put(target, envelope, rev, opts);
      },
    );
    const syncing = area.syncNow();
    await until(() => waiting);
    await tab.set({ k: "same-time pending" });
    expect((await cache.loadItems()).get("k")!.ts).toBe(initial + 1);
    release();
    await syncing;
    expect((await cache.loadItems()).get("k")).toMatchObject({
      value: "same-time pending",
      dirty: true,
    });
    expect(world.store.get(keys.base)).not.toHaveProperty("x");
  });

  it("a staged same-ts remote pull cannot overwrite an unhashed winning other-tab write", async () => {
    const { area, device, backend, cache, keys, id, cipher, read } =
      await fixture();
    const env = device.env();
    env.channel = () => null;
    const tab = await device.open({ debounceMs: 1e9 }, env);
    await tab.syncNow();
    const item = await read(id);
    item.ts++;
    item.value = "remote";
    let winner = "candidate";
    while ((await valueHash(winner)) <= (await valueHash(item.value)))
      winner += "x";
    const m = (await read(keys.base)) as Manifest;
    m.items.k = { ts: item.ts, h: await valueHash(item.value) };
    world.store.set(
      id,
      await seal(
        cipher(id),
        id,
        world.store.get(id)!.rev + 1,
        utf8(JSON.stringify(item)),
        Date.now(),
      ),
    );
    world.store.set(
      keys.base,
      await seal(
        cipher(keys.base),
        keys.base,
        world.store.get(keys.base)!.rev + 1,
        utf8(JSON.stringify(m)),
        Date.now(),
      ),
    );
    vi.spyOn(Date, "now").mockReturnValue(item.ts);
    await area.set({ dirty: "publish" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let waiting = false;
    const put = backend.put.bind(backend);
    vi.spyOn(backend, "put").mockImplementation(
      async (target, envelope, rev, opts) => {
        if (target !== keys.base) {
          waiting = true;
          await gate;
        }
        await put(target, envelope, rev, opts);
      },
    );
    const syncing = area.syncNow();
    await until(() => waiting);
    await tab.set({ k: winner });
    release();
    await syncing;
    expect((await cache.loadItems()).get("k")).toMatchObject({
      value: winner,
      dirty: true,
      ts: item.ts,
    });
    await area.syncNow();
    expect((await cache.loadItems()).get("k")).toMatchObject({ value: winner });
    expect(area.inspect().dirtyKeys).toBe(0);
  });

  it("expiry observed during the last metadata await cannot be overwritten by idle status", async () => {
    world = new World();
    const device = world.device({ cache: "memory" });
    const env = device.env();
    const cache = new MemoryCache("test", device.mem);
    env.openCache = async () => cache;
    let notify: ((env: StoredDocument) => void) | undefined;
    vi.spyOn(device.backend, "subscribe").mockImplementation((_id, cb) => {
      notify = cb;
      return () => {};
    });
    const area = await device.open({ debounceMs: 1e9 }, env);
    await area.set({ k: 1 });
    await area.syncNow();
    const keys = await deriveAppKeys(
      await decodeToken(await area.exportToken()),
      "test",
    );
    const manifest = world.store.get(keys.base)!;
    const save = cache.setMeta.bind(cache);
    vi.spyOn(cache, "setMeta").mockImplementation(async (patch) => {
      await save(patch);
      notify!({ x: true, rev: manifest.rev, next: manifest.next });
      await Promise.resolve();
    });
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(area.status).toBe("error");
    expect(await area.get()).toEqual({ k: 1 });
    const gets = device.backend.stats.gets;
    await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    expect(device.backend.stats.gets).toBe(gets);
  });

  it.each(["network", "quota"] as const)(
    "a delayed %s rejection cannot replace an already-observed manifest expiry",
    async (failure) => {
      world = new World();
      const device = world.device({ cache: "memory" });
      let notify: ((env: StoredDocument) => void) | undefined;
      vi.spyOn(device.backend, "subscribe").mockImplementation((_id, cb) => {
        notify = cb;
        return () => {};
      });
      const area = await device.open({ debounceMs: 1e9 });
      await area.set({ k: "cached" });
      await area.syncNow();
      await area.set({ pending: "dirty" });
      const keys = await deriveAppKeys(
        await decodeToken(await area.exportToken()),
        "test",
      );
      const manifest = world.store.get(keys.base)!;
      const cache = new MemoryCache("test", device.mem);
      const before = await cache.loadItems();
      const receipt = (await cache.getMeta()).renewAt;
      let reject!: (error: BackendError) => void;
      let waiting = false;
      vi.spyOn(device.backend, "get").mockImplementationOnce(async () => {
        waiting = true;
        return new Promise((_resolve, no) => {
          reject = no;
        });
      });
      const statuses: string[] = [];
      area.onStatus.addListener((s) => {
        if (s.error) statuses.push(s.error.code);
      });
      const syncing = area.syncNow();
      const settled = expect(syncing).rejects.toMatchObject({
        code: "expired",
      });
      await until(() => waiting);
      notify!({ x: true, rev: manifest.rev, next: manifest.next });
      reject(new BackendError(failure));
      await settled;
      expect(area.status).toBe("error");
      expect(statuses).toEqual(["expired"]);
      expect(await cache.loadItems()).toEqual(before);
      expect((await cache.getMeta()).renewAt).toBe(receipt);
      expect(await area.get()).toEqual({ k: "cached", pending: "dirty" });
      await expect(area.syncNow()).rejects.toMatchObject({ code: "expired" });
    },
  );

  it("due reads coalesce without indefinitely extending the renewal debounce", async () => {
    const { area, backend, cache } = await fixture();
    area.close();
    const device = world.devices[0]!;
    const active = await device.open({ debounceMs: 30 });
    await active.syncNow();
    vi.spyOn(Date, "now").mockReturnValue((await cache.getMeta()).renewAt! + 1);
    const puts = backend.stats.puts;
    const timer = setInterval(() => {
      void active.get("k");
    }, 5);
    try {
      await until(() => backend.stats.puts > puts, 1000);
    } finally {
      clearInterval(timer);
    }
  });

  it("token switching discards the old renewal receipt without contacting a token-access backend", async () => {
    const { area, device, cache } = await fixture();
    const old = (await cache.getMeta()).renewAt;
    const other = await world.device().open({ debounceMs: 1e9 });
    await other.set({ new: 1 });
    await other.syncNow();
    vi.spyOn(Date, "now").mockReturnValue(old! + DAY);
    await area.link({ token: await other.exportToken() });
    expect((await cache.getMeta()).renewAt).toBeGreaterThan(old! + DAY);
    expect(await area.get()).toEqual({ new: 1 });
    expect(device.mem.apps.size).toBe(1);
  });
});
