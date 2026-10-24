// The remote-only core (D-57): backend and token required, async network
// operations, nothing on disk, nothing queued.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../src/backends/memory.js";
import { deriveAppKeys, docId } from "../../src/codec/derive.js";
import { decodeToken, encodeToken } from "../../src/codec/token.js";
import { BackendError, BurrowError } from "../../src/errors.js";
import { burrow, generateToken } from "../../src/index.js";
import type { Envelope } from "../../src/types.js";
import { World } from "../support/devices.js";

let world: World;
afterEach(() => {
  world?.close();
  vi.restoreAllMocks();
});
const fresh = () => (world = new World());

describe("API-1 burrow() needs a backend and a token", () => {
  it("API-1 resolves with no network call, even when the store is down", async () => {
    const d = fresh().device();
    d.backend.failWith = "network";
    const s = await d.core();
    expect(d.backend.stats).toEqual({ gets: 0, puts: 0 });
    await expect(s.get()).rejects.toMatchObject({ code: "backend" });
  });

  it("rejects without a backend, with an unregistered type, or with an invalid app", async () => {
    const token = await generateToken();
    await expect(
      burrow({ app: "x", token } as unknown as Parameters<typeof burrow>[0]),
    ).rejects.toThrow(TypeError);
    await expect(
      burrow({ app: "x", token, backend: { type: "nope" } }),
    ).rejects.toThrow(TypeError);
    for (const app of ["", "Upper", "has space", "x".repeat(65)])
      await expect(
        burrow({ app, token, backend: new MemoryBackend() }),
      ).rejects.toThrow(TypeError);
  });

  it("KP-12 a missing or malformed token rejects bad-token; nothing is generated", async () => {
    const backend = new MemoryBackend();
    for (const token of [undefined, "", "not a token", "0".repeat(56)])
      await expect(
        burrow({ app: "x", backend, token: token as string }),
      ).rejects.toMatchObject({ code: "bad-token" });
    expect(backend.stats).toEqual({ gets: 0, puts: 0 });
  });

  it("KP-1 generateToken() gives a fresh 56-character token each time", async () => {
    const a = await generateToken();
    const b = await generateToken();
    expect(a).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(a).not.toBe(b);
    expect(await decodeToken(a)).toHaveLength(32);
  });

  it("KP-11 any spelling of the same token opens the same data", async () => {
    const w = fresh();
    const token = await w.token();
    const a = await w.device().core();
    await a.set({ k: 1 });
    const b = await w
      .device()
      .core({ token: token.toLowerCase().replace(/-/g, " ") });
    expect(await b.get()).toEqual({ k: 1 });
  });

  it("factory errors become a fixed backend error without the factory's message", async () => {
    const { registerBackend } = await import("../../src/config.js");
    registerBackend("core-test-throws", () => {
      throw new Error("secret config value XYZ");
    });
    const err = await burrow({
      app: "x",
      token: await generateToken(),
      backend: { type: "core-test-throws" },
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "backend" });
    expect(String(err.message) + String(err.cause)).not.toContain("XYZ");
  });
});

describe("API-3..6 the async storage interface", () => {
  it("API-3 get accepts chrome.storage argument shapes", async () => {
    const s = await fresh().device().core();
    await s.set({ a: 1, b: { c: [2] }, d: null });
    expect(await s.get()).toEqual({ a: 1, b: { c: [2] }, d: null });
    expect(await s.get(null)).toEqual({ a: 1, b: { c: [2] }, d: null });
    expect(await s.get("a")).toEqual({ a: 1 });
    expect(await s.get(["a", "missing"])).toEqual({ a: 1 });
    expect(await s.get({ a: 0, missing: "dflt" })).toEqual({
      a: 1,
      missing: "dflt",
    });
  });

  it("API-3 get returns copies", async () => {
    const s = await fresh().device().core();
    await s.set({ o: { n: 1 } });
    const got = (await s.get("o")).o as { n: number };
    got.n = 2;
    expect(await s.get("o")).toEqual({ o: { n: 1 } });
  });

  it("API-4 non-JSON values reject with TypeError and nothing is written", async () => {
    const d = fresh().device();
    const s = await d.core();
    for (const bad of [undefined, () => 1, new Date(), new Map(), NaN])
      await expect(s.set({ ok: 1, bad })).rejects.toThrow(TypeError);
    await expect(
      s.set(null as unknown as Record<string, unknown>),
    ).rejects.toThrow(TypeError);
    expect(d.backend.stats.puts).toBe(0);
  });

  it("ENC-4 item-too-large rejects before anything is written", async () => {
    const d = fresh().device();
    const s = await d.core();
    await expect(
      s.set({ ok: 1, big: "x".repeat(200_001) }),
    ).rejects.toMatchObject({ code: "item-too-large" });
    expect(d.backend.stats.puts).toBe(0);
  });

  it("D-57 remote failures reject the call; nothing is queued", async () => {
    const d = fresh().device();
    const s = await d.core();
    await s.set({ k: "stored" });
    d.backend.failWith = "network";
    await expect(s.set({ k: "lost" })).rejects.toMatchObject({
      name: "BurrowError",
      code: "backend",
    });
    await expect(s.get("k")).rejects.toMatchObject({ code: "backend" });
    d.backend.failWith = "quota";
    await expect(s.get()).rejects.toMatchObject({ code: "quota" });
    d.backend.failWith = null;
    const other = await world.device().core();
    expect(await other.get()).toEqual({ k: "stored" });
    // The failed write did not come back later either.
    await new Promise((r) => setTimeout(r, 30));
    expect(await other.get()).toEqual({ k: "stored" });
  });

  it("D-57 nothing is written to IndexedDB or Web Storage", async () => {
    // The browser suite checks a real profile (test/e2e/browser.spec.ts).
    const before = await indexedDB.databases();
    const opened = vi.spyOn(indexedDB, "open");
    const storage = (globalThis as { Storage?: typeof Storage }).Storage;
    const stored = storage && vi.spyOn(storage.prototype, "setItem");
    const s = await fresh().device().core();
    await s.set({ theme: "dark" });
    await s.get();
    await s.remove("theme");
    s.close();
    expect(opened).not.toHaveBeenCalled();
    if (stored) expect(stored).not.toHaveBeenCalled();
    expect(await indexedDB.databases()).toEqual(before);
  });

  it("close() drops the keys; later calls reject closed", async () => {
    const s = await fresh().device().core();
    await s.set({ k: 1 });
    s.close();
    for (const call of [
      () => s.get(),
      () => s.set({ k: 2 }),
      () => s.remove("k"),
      () => s.clear(),
    ])
      await expect(call()).rejects.toMatchObject({ code: "closed" });
  });
});

describe("§8 the store between devices", () => {
  it("a second device with the same token reads the data (no account)", async () => {
    const w = fresh();
    const a = await w.device().core();
    await a.set({ theme: "dark", draft: "hello" });
    const b = await w.device().core();
    expect(await b.get()).toEqual({ theme: "dark", draft: "hello" });
    expect(await b.get("draft")).toEqual({ draft: "hello" });
  });

  it("D-54 the same token gives each app its own data", async () => {
    const w = fresh();
    const a = await w.device().core({ app: "one" });
    await a.set({ k: "one" });
    const b = await w.device().core({ app: "two" });
    expect(await b.get()).toEqual({});
    await b.set({ k: "two" });
    expect(await a.get()).toEqual({ k: "one" });
  });

  it("FS-11 costs: a named read is one read; a write is one item and the manifest", async () => {
    const d = fresh().device();
    const s = await d.core();
    await s.set({ k1: 1 });
    const st = d.backend.stats;
    let [g, p] = [st.gets, st.puts];
    await s.get("k1");
    expect([st.gets - g, st.puts - p]).toEqual([1, 0]);
    [g, p] = [st.gets, st.puts];
    await s.get();
    // the manifest; the item is already known to this instance
    expect([st.gets - g, st.puts - p]).toEqual([1, 0]);
    [g, p] = [st.gets, st.puts];
    await s.set({ k1: 2 }); // known revision (D-10): no item read
    expect([st.gets - g, st.puts - p]).toEqual([1, 2]);
    [g, p] = [st.gets, st.puts];
    await s.set({ k2: 1, k3: 1 }); // new keys: one read each
    expect([st.gets - g, st.puts - p]).toEqual([3, 3]);
  });

  it("SYNC-9 item written, manifest refused: the call rejects and the next write lists the item", async () => {
    class ManifestFails extends MemoryBackend {
      failId: string | null = null;
      override async put(
        id: string,
        env: Envelope,
        expectedRev: number | null,
      ): Promise<void> {
        if (id === this.failId) throw new BackendError("network");
        return super.put(id, env, expectedRev);
      }
    }
    const w = fresh();
    const be = new ManifestFails({ store: w.store });
    const s = await w.device().core({ backend: be });
    const keys = await deriveAppKeys(
      await decodeToken(await w.token()),
      "test",
    );
    be.failId = keys.base;
    await expect(s.set({ first: 1 })).rejects.toMatchObject({
      code: "backend",
    });
    expect(w.store.has(await docId(keys, "first"))).toBe(true);
    be.failId = null;
    await s.set({ second: 2 });
    const other = await w.device().core();
    expect(await other.get()).toEqual({ first: 1, second: 2 });
  });

  it("SYNC-8 concurrent writes from two devices both land (manifest conflicts merge)", async () => {
    const w = fresh();
    const a = await w.device().core();
    const b = await w.device().core();
    await Promise.all([a.set({ fromA: 1 }), b.set({ fromB: 2 })]);
    expect(await a.get()).toEqual({ fromA: 1, fromB: 2 });
  });

  it("the same key written on two devices ends with the write that committed last", async () => {
    const w = fresh();
    const a = await w.device().core();
    const b = await w.device().core();
    await a.set({ k: "a" });
    await b.set({ k: "b" });
    expect(await a.get("k")).toEqual({ k: "b" });
    await a.set({ k: "a2" });
    expect(await b.get()).toEqual({ k: "a2" });
  });

  it("SYNC-11 a device with a slow clock still overwrites a newer remote write", async () => {
    const w = fresh();
    const fast = await w.device().core();
    const slow = await w.device().core();
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + 3_600_000);
    await fast.set({ k: "from the future" });
    vi.restoreAllMocks();
    await slow.set({ k: "later, with a slow clock" });
    expect(await fast.get("k")).toEqual({ k: "later, with a slow clock" });
  });

  it("SYNC-12 remove() writes a tombstone; clear() removes every key everywhere", async () => {
    const w = fresh();
    const a = await w.device().core();
    const b = await w.device().core();
    await a.set({ x: 1, y: 2, z: 3 });
    await b.remove("x");
    expect(await a.get()).toEqual({ y: 2, z: 3 });
    expect(await a.get("x")).toEqual({});
    await b.remove(["never-existed"]);
    await a.clear();
    expect(await b.get()).toEqual({});
    await b.set({ x: "again" });
    expect(await a.get()).toEqual({ x: "again" });
  });

  it("ENC-1/FS-2 the store holds only 43-character ids and envelope fields", async () => {
    const w = fresh();
    const s = await w.device().core();
    await s.set({ "secret-key": "secret value" });
    const dump = JSON.stringify([...w.store]);
    expect(dump).not.toContain("secret");
    expect(dump).not.toContain(await w.token());
    for (const [id, env] of w.store) {
      expect(id).toHaveLength(43);
      expect(Object.keys(env).sort()).toEqual(
        ["ct", "iv", "next", "rev", "tok", "ts", "v", "z"].filter(
          (k) => k in env,
        ),
      );
    }
  });

  it("ENC-6 a document that does not decrypt rejects decrypt-failed", async () => {
    const w = fresh();
    const s = await w.device().core();
    await s.set({ k: 1 });
    const keys = await deriveAppKeys(
      await decodeToken(await w.token()),
      "test",
    );
    const id = await docId(keys, "k");
    const env = w.store.get(id) as Envelope;
    w.store.set(id, {
      ...env,
      ct: env.ct.replace(/^./, (c) => (c === "A" ? "B" : "A")),
    });
    const reader = await w.device().core();
    await expect(reader.get("k")).rejects.toMatchObject({
      code: "decrypt-failed",
    });
  });

  it("a different token reads nothing and cannot read the first token's documents", async () => {
    const w = fresh();
    const a = await w.device().core();
    await a.set({ k: 1 });
    const other = await w.device().core({ token: await generateToken() });
    expect(await other.get()).toEqual({});
    expect(await other.get("k")).toEqual({});
  });

  it("D-48 an expiry stub rejects expired on read and write", async () => {
    const w = fresh();
    const s = await w.device().core();
    await s.set({ k: 1 });
    const keys = await deriveAppKeys(
      await decodeToken(await w.token()),
      "test",
    );
    const id = await docId(keys, "k");
    const cur = w.store.get(id)!;
    w.store.set(id, { x: true, rev: cur.rev, next: cur.next });
    const fresh2 = await w.device().core();
    await expect(fresh2.get("k")).rejects.toMatchObject({ code: "expired" });
    await expect(fresh2.get()).rejects.toMatchObject({ code: "expired" });
    await expect(fresh2.set({ k: 2 })).rejects.toMatchObject({
      code: "expired",
    });
    const m = w.store.get(keys.base)!;
    w.store.set(keys.base, { x: true, rev: m.rev, next: m.next });
    await expect(s.get()).rejects.toMatchObject({ code: "expired" });
    expect(w.store.get(id)).toMatchObject({ x: true });
  });

  it("API-13 rejections are BurrowErrors with scrubbed causes", async () => {
    const d = fresh().device();
    const s = await d.core();
    vi.spyOn(d.backend, "get").mockRejectedValue(
      new BackendError("network", "id " + "A".repeat(43)),
    );
    const err = await s.get("k").catch((e) => e);
    expect(err).toBeInstanceOf(BurrowError);
    expect(JSON.stringify(err.cause?.message)).not.toContain("A".repeat(43));
  });

  it("KP-11 tokens encoded from the same secret open the same keys", async () => {
    const w = fresh();
    const token = await w.token();
    const again = await encodeToken(await decodeToken(token));
    expect(again).toBe(token);
  });
});
