import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cache } from "../../src/cache/types.js";
import type { Core } from "../../src/core.js";
import type { ChangedEvent } from "../../src/types.js";
import { appTests } from "../sample-app/app.spec.js";
import { World, until } from "../support/devices.js";

let world: World;
afterEach(() => world?.close());

describe("API-9..12 Storage facade", () => {
  let a: Core;
  beforeEach(async () => {
    world = new World();
    a = await world.device().open();
  });

  it("API-9 implements Storage semantics: strings, null for missing, synchronous", () => {
    const s = a.storage;
    expect(s.getItem("nope")).toBeNull();
    s.setItem("n", 42 as unknown as string);
    expect(s.getItem("n")).toBe("42");
    s.setItem("o", { a: 1 } as unknown as string);
    expect(s.getItem("o")).toBe("[object Object]");
    expect(s.length).toBe(2);
    expect([s.key(0), s.key(1), s.key(2)]).toEqual(["n", "o", null]);
    s.removeItem("n");
    expect(s.getItem("n")).toBeNull();
    s.clear();
    expect(s.length).toBe(0);
    expect(Object.prototype.toString.call(s)).toBe("[object Storage]");
  });

  it("API-10 the mirror is loaded before burrow() resolves", async () => {
    await a.set({ k: "v", j: { x: 1 } });
    a.close();
    const b = await world.devices[0]!.open();
    expect(b.storage.getItem("k")).toBe("v");
    expect(b.storage.getItem("j")).toBe('{"x":1}'); // non-string values written via set() read as JSON
  });

  it("API-11 facade writes are visible at once and reach the cache and the async API", async () => {
    a.storage.setItem("draft", "text");
    expect(a.storage.getItem("draft")).toBe("text");
    expect(await a.get("draft")).toEqual({ draft: "text" });
    await until(async () => {
      a.close();
      const b = await world.devices[0]!.open();
      return b.storage.getItem("draft") === "text";
    });
  });

  it("API-11 pending facade writes are flushed on pagehide and pushed", async () => {
    const d = world.devices[0]!;
    a.storage.setItem("late", "1");
    d.win.dispatchEvent(new Event("pagehide"));
    await until(
      () => a.inspect().dirtyKeys === 0 && a.inspect().manifestRev !== null,
    );
  });

  it("API-11 N synchronous facade writes in one tick persist in one cache transaction", async () => {
    const d = world.device();
    const env = d.env();
    let cache: Cache | undefined;
    const openCache = env.openCache;
    env.openCache = async (app, kind) => (cache = await openCache(app, kind));
    const b = await d.open({ debounceMs: 1e9 }, env); // no push, so no sync pass writes these keys
    await b.syncNow(); // let the first pass finish
    const write = vi.spyOn(cache!, "updateItems");
    const put = vi.spyOn(cache!, "putItems");
    const N = 25;
    for (let i = 0; i < N; i++) b.storage.setItem(`n${i}`, String(i));
    b.storage.removeItem("n0");
    expect(b.storage.length).toBe(N - 1);
    await until(() => write.mock.calls.some(([keys]) => keys.includes("n1")));
    await new Promise((r) => setTimeout(r, 20));
    const ours = write.mock.calls.filter(([keys]) =>
      keys.some((k) => /^n\d+$/.test(k)),
    );
    expect(ours).toHaveLength(1);
    expect([...ours[0]![0]].sort()).toEqual(
      Array.from({ length: N }, (_, i) => `n${i}`).sort(),
    );
    expect(put).not.toHaveBeenCalled();
    expect(b.inspect().dirtyKeys).toBe(N); // n0 is a dirty tombstone
  });

  it("API-11 pending facade writes are flushed on visibilitychange to hidden and pushed", async () => {
    const d = world.device();
    const b = await d.open({ debounceMs: 1e9 }); // no debounced push: only hiding the page pushes
    await b.syncNow();
    expect(b.inspect().manifestRev).toBeNull();
    b.storage.setItem("late", "1");
    d.visibility.visibilityState = "hidden";
    d.win.dispatchEvent(new Event("visibilitychange"));
    await until(
      () => b.inspect().dirtyKeys === 0 && b.inspect().manifestRev !== null,
    );
    const other = await world.device().open();
    await other.link({ code: await b.exportCode() });
    expect(other.storage.getItem("late")).toBe("1");
  });

  it("API-12 changes are forwarded to onChanged, batched, and no window storage event fires", async () => {
    const seen: ChangedEvent[] = [];
    let storageEvents = 0;
    world.devices[0]!.win.addEventListener("storage", () => storageEvents++);
    a.onChanged.addListener((e) => seen.push(e));
    a.storage.setItem("a", "1");
    a.storage.setItem("a", "2");
    a.storage.setItem("b", "x");
    a.storage.removeItem("b");
    await until(() => seen.length > 0);
    expect(seen).toEqual([
      { source: "local", changes: { a: { newValue: "2" } } },
    ]);
    expect(storageEvents).toBe(0);
  });

  it("ERR-1 setItem throws item-too-large synchronously", async () => {
    const b = await world.device().open({ maxItemBytes: 100 });
    expect(() => b.storage.setItem("big", "x".repeat(200))).toThrow(
      expect.objectContaining({ code: "item-too-large" }),
    );
    expect(b.storage.getItem("big")).toBeNull();
  });

  it("supports property access like localStorage", () => {
    const s = a.storage as Storage & Record<string, string>;
    s.theme = "dark";
    s["font"] = "serif";
    expect(s.theme).toBe("dark");
    expect("font" in s).toBe(true);
    expect(Object.keys(s).sort()).toEqual(["font", "theme"]);
    delete s.font;
    expect(s.getItem("font")).toBeNull();
    expect(typeof s.getItem).toBe("function");
    s.setItem("getItem", "shadowed?");
    expect(typeof s.getItem).toBe("function");
  });

  it("a facade write on one device reaches another", async () => {
    const b = await world.device().open();
    await b.link({ code: await a.exportCode() });
    a.storage.setItem("shared", "yes");
    await a.syncNow();
    await b.syncNow();
    expect(b.storage.getItem("shared")).toBe("yes");
  });
});

// Acceptance: replacing localStorage with store.storage requires no other change.
describe("sample app: localStorage -> store.storage by find-and-replace", () => {
  const source = readFileSync(
    new URL("../sample-app/app.js", import.meta.url),
    "utf8",
  );
  const swapped = source.replaceAll("localStorage", "store.storage");
  const dir = mkdtempSync(join(tmpdir(), "burrow-sample-"));
  let n = 0;
  const load = async (code: string) => {
    const f = join(dir, `app-${n++}.mjs`);
    writeFileSync(f, code);
    return import(/* @vite-ignore */ f);
  };

  it("the only difference is the identifier", () => {
    expect(swapped).not.toContain("localStorage");
    expect(swapped.replaceAll("store.storage", "localStorage")).toBe(source);
  });

  for (const [name, test] of appTests) {
    it(`with store.storage: ${name}`, async () => {
      world = new World();
      const store = await world.device().open();
      (globalThis as { store?: unknown }).store = store;
      try {
        await test(await load(swapped));
      } finally {
        delete (globalThis as { store?: unknown }).store;
      }
    });
  }

  const native = (globalThis as { localStorage?: Storage }).localStorage;
  for (const [name, test] of appTests) {
    it.skipIf(!native)(
      `with the platform's localStorage (reference): ${name}`,
      async () => {
        native!.clear();
        await test(await load(source));
      },
    );
  }
});
