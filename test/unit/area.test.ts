import { afterEach, describe, expect, it, vi } from "vitest";
import { BurrowError } from "../../src/errors.js";
import type { ChangedEvent, StatusEvent } from "../../src/types.js";
import { World, until } from "../support/devices.js";

let world: World;
afterEach(() => { world?.close(); vi.restoreAllMocks(); });
const fresh = () => (world = new World());

describe("API-1/API-2 entry point", () => {
  it("API-1 resolves with no interaction and no providers invoked", async () => {
    const w = fresh(); const d = w.device();
    const enrol = vi.fn(), recover = vi.fn();
    const a = await d.open({ keyProvider: { id: "x", available: async () => true, enrol, recover } });
    expect(a.status).not.toBe("error");
    expect(a.protection).toBe("none");
    expect(enrol).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("API-2 same app on one page returns the same instance; other apps differ", async () => {
    const d = fresh().device(); const env = d.env();
    const [a, b] = await Promise.all([d.open({}, env), d.open({}, env)]);
    expect(a).toBe(b);
    expect(await d.open({ app: "other" }, env)).not.toBe(a);
  });

  it("rejects an invalid app id", async () => {
    const d = fresh().device();
    for (const app of ["", "Upper", "has space", "x".repeat(65)]) await expect(d.open({ app })).rejects.toThrow(TypeError);
  });

  it("KP-1/KP-2 the secret persists across page loads on the device", async () => {
    const d = fresh().device();
    const a = await d.open();
    await a.set({ theme: "dark" });
    const code = await a.exportCode();
    a.close();
    const b = await d.open();
    expect(b).not.toBe(a);
    expect(await b.exportCode()).toBe(code);
    expect(await b.get("theme")).toEqual({ theme: "dark" });
  });

  it("KP-1 different devices start with different secrets", async () => {
    const w = fresh();
    expect(await (await w.device().open()).exportCode()).not.toBe(await (await w.device().open()).exportCode());
  });
});

describe("API-3..6 StorageArea", () => {
  it("API-3 get accepts chrome.storage argument shapes", async () => {
    const a = await fresh().device().open();
    await a.set({ a: 1, b: { c: [2] }, d: null });
    expect(await a.get()).toEqual({ a: 1, b: { c: [2] }, d: null });
    expect(await a.get(null)).toEqual({ a: 1, b: { c: [2] }, d: null });
    expect(await a.get("a")).toEqual({ a: 1 });
    expect(await a.get(["a", "missing"])).toEqual({ a: 1 });
    expect(await a.get({ a: 0, missing: "dflt" })).toEqual({ a: 1, missing: "dflt" });
    expect(await a.get([])).toEqual({});
  });

  it("API-3 get returns copies, not the cached objects", async () => {
    const a = await fresh().device().open();
    await a.set({ o: { n: 1 } });
    const { o } = (await a.get("o")) as { o: { n: number } };
    o.n = 2;
    expect(await a.get("o")).toEqual({ o: { n: 1 } });
  });

  it("API-3/API-6 reads and writes never wait on the network", async () => {
    const d = fresh().device({ latencyMs: 60_000 });
    const a = await d.open();
    const t = Date.now();
    await a.set({ x: 1 });
    expect(await a.get("x")).toEqual({ x: 1 });
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("API-4 non-JSON values throw TypeError at set() and nothing is written", async () => {
    const a = await fresh().device().open();
    await expect(a.set({ ok: 1, bad: new Date() })).rejects.toThrow(TypeError);
    await expect(a.set({ f: () => 1 })).rejects.toThrow(TypeError);
    await expect(a.set({ m: new Map() })).rejects.toThrow(TypeError);
    await expect(a.set({ u: undefined })).rejects.toThrow(TypeError);
    expect(await a.get()).toEqual({});
  });

  it("ENC-4 item-too-large rejects before anything is written", async () => {
    const a = await fresh().device().open({ maxItemBytes: 1000 });
    await expect(a.set({ ok: 1, big: "x".repeat(2000) })).rejects.toMatchObject({ name: "BurrowError", code: "item-too-large" });
    expect(await a.get()).toEqual({});
  });

  it("API-5 onChanged fires for local writes with chrome's shape, skipping no-ops", async () => {
    const a = await fresh().device().open();
    const seen: ChangedEvent[] = [];
    a.onChanged.addListener((e) => seen.push(e));
    await a.set({ a: 1, b: 2 });
    await a.set({ a: 1 });
    await a.set({ a: 3 });
    await a.remove("b");
    await a.remove("nope");
    expect(seen).toEqual([
      { source: "local", changes: { a: { newValue: 1 }, b: { newValue: 2 } } },
      { source: "local", changes: { a: { oldValue: 1, newValue: 3 } } },
      { source: "local", changes: { b: { oldValue: 2 } } },
    ]);
  });

  it("onChanged is also a real EventTarget", async () => {
    const a = await fresh().device().open();
    const got: unknown[] = [];
    a.onChanged.addEventListener("changed", (e) => got.push((e as CustomEvent).detail.changes));
    await a.set({ k: "v" });
    expect(got).toEqual([{ k: { newValue: "v" } }]);
  });

  it("API-6 set() resolves while the remote is down; failures surface via onStatus", async () => {
    const d = fresh().device();
    const a = await d.open();
    const statuses: StatusEvent[] = [];
    a.onStatus.addListener((s) => statuses.push(s));
    d.backend.failWith = "network";
    await a.set({ x: 1 });
    await until(() => a.status === "offline");
    expect(statuses.at(-1)).toMatchObject({ status: "offline", error: { code: "backend" } });
    expect(a.inspect().dirtyKeys).toBe(1);
    d.backend.failWith = null;
    await a.syncNow();
    expect(a.status).toBe("idle");
    expect(a.inspect().dirtyKeys).toBe(0);
  });

  it("quota failures report error.code = quota and keep the data", async () => {
    const d = fresh().device();
    const a = await d.open();
    d.backend.failWith = "quota";
    await a.set({ x: 1 });
    await expect(a.syncNow()).rejects.toMatchObject({ code: "quota" });
    expect(a.status).toBe("offline");
    expect(a.inspect().dirtyKeys).toBe(1);
  });

  it("getBytesInUse, exportJSON and importJSON", async () => {
    const w = fresh();
    const a = await w.device().open();
    await a.set({ ab: "cd", n: 12 });
    expect(await a.getBytesInUse("ab")).toBe(2 + 4);
    expect(await a.getBytesInUse()).toBe(6 + 1 + 2);
    const json = await a.exportJSON();
    const b = await w.device().open();
    await b.importJSON(json);
    expect(await b.get()).toEqual({ ab: "cd", n: 12 });
    await expect(b.importJSON("{}")).rejects.toThrow(TypeError);
  });

  it("ERR-4 inspect() is a plain object without secrets", async () => {
    const d = fresh().device();
    const a = await d.open();
    await a.set({ k: 1 });
    await a.syncNow();
    const i = a.inspect();
    expect(i).toMatchObject({ status: "idle", protection: "none", manifestRev: 0, dirtyKeys: 0, backend: "memory", provider: null });
    expect(typeof i.lastSyncAt).toBe("number");
    expect(JSON.stringify(i)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});

describe("§8 sync between devices", () => {
  async function pair() {
    const w = fresh();
    const A = w.device(), B = w.device();
    const a = await A.open();
    const b = await B.open();
    await b.link({ code: await a.exportCode() });
    return { w, A, B, a, b };
  }

  it("a second device linked by sync code sees the data (with no account)", async () => {
    const w = fresh();
    const a = await w.device().open();
    await a.set({ theme: "dark", draft: "hello" });
    await a.syncNow();
    const b = await w.device().open();
    const events: ChangedEvent[] = [];
    b.onChanged.addListener((e) => events.push(e));
    await b.link({ code: await a.exportCode() });
    expect(await b.get()).toEqual({ theme: "dark", draft: "hello" });
    expect(b.protection).toBe("code");
    expect(events).toEqual([{ source: "remote", changes: { theme: { newValue: "dark" }, draft: { newValue: "hello" } } }]);
  });

  it("API-5/SYNC-13 remote changes arrive batched, once per pass, with source remote", async () => {
    const { a, b } = await pair();
    const events: ChangedEvent[] = [];
    b.onChanged.addListener((e) => events.push(e));
    await a.set({ x: 1, y: 2 });
    await a.syncNow();
    await b.syncNow();
    expect(events).toEqual([{ source: "remote", changes: { x: { newValue: 1 }, y: { newValue: 2 } } }]);
    await b.syncNow();
    expect(events).toHaveLength(1);
  });

  it("FS-11 costs: an idle pull is one read; a push is one write per item plus the manifest", async () => {
    const { a, A } = await pair();
    await a.syncNow();
    const s = A.backend.stats;
    let g = s.gets, p = s.puts;
    await a.syncNow();
    expect([s.gets - g, s.puts - p]).toEqual([1, 0]);
    await a.set({ k1: 1, k2: 2, k3: 3 });
    g = s.gets; p = s.puts;
    await a.syncNow();
    expect(s.puts - p).toBe(4);
  });

  it("SYNC-5 writes are debounced and coalesced into one push", async () => {
    const w = fresh(); const d = w.device();
    const a = await d.open({ debounceMs: 50 });
    await a.syncNow();
    const p = d.backend.stats.puts;
    for (let i = 0; i < 10; i++) await a.set({ counter: i });
    await until(() => a.inspect().dirtyKeys === 0);
    expect(d.backend.stats.puts - p).toBe(2); // one item, one manifest
  });

  it("different keys edited offline on two devices converge with both changes", async () => {
    const { a, b, A, B } = await pair();
    A.backend.failWith = "network"; B.backend.failWith = "network";
    await a.set({ fromA: 1 });
    await b.set({ fromB: 2 });
    A.backend.failWith = null; B.backend.failWith = null;
    await Promise.all([a.syncNow(), b.syncNow()]);
    await a.syncNow(); await b.syncNow();
    expect(await a.get()).toEqual({ fromA: 1, fromB: 2 });
    expect(await b.get()).toEqual({ fromA: 1, fromB: 2 });
  });

  it("the same key edited on two devices converges on the later write", async () => {
    const { a, b, A, B } = await pair();
    A.backend.failWith = "network"; B.backend.failWith = "network";
    await a.set({ k: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await b.set({ k: "later" });
    A.backend.failWith = null; B.backend.failWith = null;
    await Promise.all([b.syncNow(), a.syncNow()]);
    await a.syncNow(); await b.syncNow();
    expect(await a.get("k")).toEqual({ k: "later" });
    expect(await b.get("k")).toEqual({ k: "later" });
  });

  it("SYNC-12 a delete on A removes the key on B, and a stale device C does not resurrect it", async () => {
    const w = fresh();
    const a = await w.device().open();
    await a.set({ gone: "soon", stays: 1 });
    await a.syncNow();
    const code = await a.exportCode();
    const b = await w.device().open(); await b.link({ code });
    const c = await w.device().open(); await c.link({ code });
    expect(await c.get("gone")).toEqual({ gone: "soon" });
    await a.remove("gone");
    await a.syncNow();
    await b.syncNow();
    expect(await b.get()).toEqual({ stays: 1 });
    // C never saw the delete; it syncs again, also pushing an unrelated write.
    await c.set({ other: true });
    await c.syncNow();
    await a.syncNow(); await b.syncNow();
    for (const x of [a, b, c]) expect(await x.get()).toEqual({ stays: 1, other: true });
  });

  it("clear() removes every key everywhere", async () => {
    const { a, b } = await pair();
    await a.set({ x: 1, y: 2 }); await a.syncNow(); await b.syncNow();
    await b.clear(); await b.syncNow(); await a.syncNow();
    expect(await a.get()).toEqual({});
  });

  it("SYNC-8 concurrent pushes from two devices both land (manifest conflicts merge)", async () => {
    const { a, b } = await pair();
    await Promise.all([a.set({ a1: 1, a2: 2 }), b.set({ b1: 1, b2: 2 })]);
    await Promise.all([a.syncNow(), b.syncNow()]);
    await a.syncNow(); await b.syncNow();
    expect(await a.get()).toEqual({ a1: 1, a2: 2, b1: 1, b2: 2 });
    expect(await b.get()).toEqual({ a1: 1, a2: 2, b1: 1, b2: 2 });
  });

  it("SYNC-11 a device with a slow clock still wins after it has seen newer remote writes", async () => {
    const { a, b } = await pair();
    await a.set({ k: "a" });
    await a.syncNow();
    await b.syncNow();
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real - 3_600_000); // b's clock is an hour behind
    await b.set({ k: "b-later" });
    await b.syncNow();
    vi.restoreAllMocks();
    await a.syncNow();
    expect(await a.get("k")).toEqual({ k: "b-later" });
  });

  it("SYNC-7 get({fresh}) fetches specific items directly", async () => {
    const w = fresh();
    const A = w.device(), B = w.device();
    (B.backend.capabilities as { subscribe: boolean }).subscribe = false; // no live updates on B
    const a = await A.open();
    const b = await B.open();
    await b.link({ code: await a.exportCode() });
    await a.set({ k: 1 }); await a.syncNow();
    expect(await b.get("k")).toEqual({});
    expect(await b.get("k", { fresh: true })).toEqual({ k: 1 });
  });

  it("subscribe: the manifest listener pulls remote changes without polling", async () => {
    const { a, b } = await pair();
    await a.set({ live: 1 });
    await a.syncNow();
    await until(async () => (await b.get("live")).live === 1);
  });

  it("ENC-1/FS-2 a store dump holds only 43-char ids and envelope fields, nothing in the clear", async () => {
    const w = fresh();
    const a = await w.device().open();
    await a.set({ "secret-key-name": "secret value", nested: { password: "hunter2" } });
    await a.syncNow();
    const dump = JSON.stringify([...w.store]);
    for (const s of ["secret-key-name", "secret value", "password", "hunter2", "test"]) expect(dump).not.toContain(s);
    for (const [id, env] of w.store) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Object.keys(env).every((k) => ["v", "iv", "ct", "rev", "ts", "tok", "next", "z"].includes(k))).toBe(true);
    }
  });

  it("ENC-6 a document that does not decrypt pauses sync and leaves the cache alone", async () => {
    const { a, b, w } = await pair();
    await a.set({ k: 1 }); await a.syncNow(); await b.syncNow();
    for (const [id, env] of w.store) w.store.set(id, { ...env, ct: env.ct.replace(/^./, (c) => (c === "A" ? "B" : "A")) });
    await expect(b.syncNow()).rejects.toMatchObject({ code: "decrypt-failed" });
    expect(b.status).toBe("error");
    expect(await b.get()).toEqual({ k: 1 });
    await b.set({ local: "still works" });
    expect(await b.get("local")).toEqual({ local: "still works" });
  });
});

describe("§6 link, protect, unlink", () => {
  it("KP-12 a bad code is rejected before any network call", async () => {
    const d = fresh().device();
    const a = await d.open();
    const g = d.backend.stats.gets;
    await expect(a.link({ code: "0000-0000" })).rejects.toMatchObject({ code: "bad-code" });
    expect(d.backend.stats.gets).toBe(g);
  });

  it("API-7 link() with no provider able to recover rejects no-provider", async () => {
    const a = await fresh().device().open({ keyProvider: { id: "x", available: async () => true, enrol: async () => {}, recover: async () => null } });
    await expect(a.link()).rejects.toMatchObject({ code: "no-provider" });
  });

  it("API-7 link() tries providers in order", async () => {
    const w = fresh();
    const a = await w.device().open();
    await a.set({ k: 1 }); await a.syncNow();
    const code = await a.exportCode();
    const calls: string[] = [];
    const p = (id: string, out: string | null) => ({
      id, available: async () => true, enrol: async () => {},
      recover: async () => { calls.push(id); return out ? (await import("../../src/codec/synccode.js")).decodeSyncCode(out).then((r) => r.secret) : null; },
    });
    const b = await w.device().open({ keyProvider: [p("one", null), p("two", code), p("three", null)] });
    await b.link();
    expect(calls).toEqual(["one", "two"]);
    expect(b.protection).toBe("two");
    expect(await b.get()).toEqual({ k: 1 });
  });

  it("API-7 would-orphan: a device holding unsynced data under another secret", async () => {
    const w = fresh();
    const a = await w.device().open();
    const B = w.device();
    const b = await B.open();
    B.backend.failWith = "network";
    await b.set({ unsynced: 1 });
    await expect(b.link({ code: await a.exportCode() })).rejects.toMatchObject({ code: "would-orphan" });
    expect(await b.get()).toEqual({ unsynced: 1 });
    B.backend.failWith = null;
    await a.set({ fromA: 1 }); await a.syncNow();
    // With discardLocal the device adopts the other secret.
    B.backend.failWith = "network";
    await b.link({ code: await a.exportCode(), discardLocal: true });
    B.backend.failWith = null;
    await b.syncNow();
    expect(await b.get()).toEqual({ fromA: 1 });
  });

  it("link() pushes unsynced data under the old secret first when it can", async () => {
    const w = fresh();
    const a = await w.device().open();
    const b = await w.device().open();
    const oldCode = await b.exportCode();
    await b.set({ mine: 1 });
    await b.link({ code: await a.exportCode() });
    const c = await w.device().open();
    await c.link({ code: oldCode });
    expect(await c.get()).toEqual({ mine: 1 });
  });

  it("API-8 unlink() forgets the secret; the cache and remote stay; the next burrow() is a fresh secret", async () => {
    const w = fresh(); const d = w.device();
    const a = await d.open();
    await a.set({ k: 1 }); await a.syncNow();
    const code = await a.exportCode();
    const docs = w.store.size;
    await a.unlink();
    expect(await d.idb.databases()).toHaveLength(1);
    expect(w.store.size).toBe(docs);
    await expect(a.get()).rejects.toBeInstanceOf(BurrowError);
    const b = await d.open();
    expect(b).not.toBe(a);
    expect(await b.exportCode()).not.toBe(code);
    expect(await b.get()).toEqual({});
    await b.link({ code });
    expect(await b.get()).toEqual({ k: 1 });
  });

  it("API-8 unlink() refuses to orphan unsynced data unless told to", async () => {
    const d = fresh().device();
    const a = await d.open();
    d.backend.failWith = "network";
    await a.set({ k: 1 });
    await expect(a.unlink()).rejects.toMatchObject({ code: "would-orphan" });
    await a.unlink({ discardLocal: true });
  });

  it("protect('sync-code') and exportCode() mark the secret protected", async () => {
    const a = await fresh().device().open();
    await a.protect("sync-code");
    expect(a.protection).toBe("code");
    expect(a.inspect().provider).toBe("sync-code");
  });

  it("protect() with an unknown provider rejects no-provider", async () => {
    const a = await fresh().device().open();
    await expect(a.protect("nope")).rejects.toMatchObject({ code: "no-provider" });
  });

  it("KP-14 onUnprotected fires once per device when data exists and nothing protects it", async () => {
    const d = fresh().device();
    const a = await d.open();
    let fired = 0;
    a.onUnprotected.addListener(() => fired++);
    await a.set({ k: 1 });
    await until(() => fired === 1);
    await a.set({ k: 2 });
    a.close();
    const b = await d.open();
    b.onUnprotected.addListener(() => fired++);
    await b.set({ k: 3 });
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(1);
  });

  it("KP-13 a #burrow=<code> fragment links the device and is stripped from the URL", async () => {
    const w = fresh();
    const a = await w.device().open();
    await a.set({ k: "shared" }); await a.syncNow();
    const D = w.device();
    const code = await a.exportCode();
    D.location = { href: `https://example.test/app#burrow=${code}`, hash: `#burrow=${code}` };
    const b = await D.open();
    expect(await b.get()).toEqual({ k: "shared" });
    expect(D.location!.href).toBe("https://example.test/app");
  });

  it("rememberDevice: false keeps the secret in memory only", async () => {
    const d = fresh().device();
    const a = await d.open({ rememberDevice: false });
    const code = await a.exportCode();
    a.close();
    expect(await (await d.open({ rememberDevice: false })).exportCode()).not.toBe(code);
  });
});

describe("SYNC-14 tabs", () => {
  it("a write in one tab updates the other tab's mirror and fires onChanged there", async () => {
    const d = fresh().device();
    const t1 = await d.open({}, d.env());
    const t2 = await d.open({}, d.env());
    expect(t1).not.toBe(t2);
    expect(await t1.exportCode()).toBe(await t2.exportCode());
    const seen: ChangedEvent[] = [];
    t2.onChanged.addListener((e) => seen.push(e));
    await t1.set({ k: "from t1" });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ source: "local", changes: { k: { newValue: "from t1" } } });
    expect(t2.storage.getItem("k")).toBe("from t1");
  });

  it("only one tab syncs at a time and the result reaches both", async () => {
    const w = fresh(); const d = w.device();
    const t1 = await d.open({}, d.env());
    const t2 = await d.open({}, d.env());
    await t1.set({ a: 1 });
    await t2.set({ b: 2 });
    await Promise.all([t1.syncNow(), t2.syncNow()]);
    const other = await w.device().open();
    await other.link({ code: await t1.exportCode() });
    expect(await other.get()).toEqual({ a: 1, b: 2 });
  });

  it("linking in one tab moves the other tab to the new identity", async () => {
    const w = fresh(); const d = w.device();
    const src = await w.device().open();
    await src.set({ x: "linked" }); await src.syncNow();
    const t1 = await d.open({}, d.env());
    const t2 = await d.open({}, d.env());
    await t1.link({ code: await src.exportCode() });
    await until(async () => (await t2.get("x")).x === "linked");
  });
});
