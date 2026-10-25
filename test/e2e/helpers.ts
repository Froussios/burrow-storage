import type { BrowserContext, Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "";
if (!EMU) throw new Error("run under the emulator: npm run test:e2e");

/**
 * Open the harness page (burrow.min.js + emulator config) and a store for
 * `app` as `window.store`: the core, or the offline wrapper over it. The token
 * is `opts.token`, or a new one; either way it is `window.token`.
 */
export async function openArea(
  context: BrowserContext,
  app = "e2e",
  page?: Page,
  opts: {
    offline?: boolean;
    token?: string;
    /** Runs after the page has loaded, before the store opens. */
    beforeOpen?: () => Promise<void>;
  } = {},
): Promise<Page> {
  const p = page ?? (await context.newPage());
  await p.goto(`/test/e2e/harness.html?emu=${EMU}`);
  await opts.beforeOpen?.();
  await p.evaluate(
    async ([app, opts]) => {
      const w = window as unknown as {
        store: unknown;
        token: string;
        Burrow: typeof import("../../src/iife.js");
      };
      w.token = opts.token ?? (await w.Burrow.generateToken());
      const core = await w.Burrow.burrow({
        app,
        backend: w.Burrow.readBackendConfig()!,
        token: w.token,
      });
      w.store = opts.offline ? await w.Burrow.offline(core) : core;
    },
    [app, { offline: opts.offline, token: opts.token }] as const,
  );
  return p;
}

/**
 * Burrow's own IndexedDB databases in a profile dump. Other libraries may keep
 * their own, such as the Firebase SDK's heartbeat record (SDK versions and
 * dates); tests check those only for Burrow data.
 */
export const databases = (dump: string): string[] =>
  Object.keys(JSON.parse(dump).indexedDB)
    .filter((n) => n.startsWith("burrow:"))
    .sort();

/**
 * The Firestore document ids this page's requests name, as they appear on the
 * wire (the Listen channel sends them URL-encoded).
 */
export function documentIds(page: Page): Set<string> {
  const ids = new Set<string>();
  page.on("request", (r) => {
    let body = r.postData() ?? "";
    try {
      body = decodeURIComponent(body.replace(/\+/g, " "));
    } catch {
      /* not URL-encoded */
    }
    for (const m of body.matchAll(/documents\/[^/"]+\/([A-Za-z0-9_-]{20,})/g))
      ids.add(m[1]!);
  });
  return ids;
}

/** Each file under `dir` that holds one of `needles`, by label. */
export function scanProfile(
  dir: string,
  needles: [label: string, text: string][],
): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const bytes = readFileSync(p);
        const text = bytes.toString("latin1") + bytes.toString("utf16le");
        for (const [label, n] of needles)
          if (text.includes(n)) (hits[label] ??= []).push(p.slice(dir.length));
      }
    }
  };
  walk(dir);
  return hits;
}

export type Store = {
  set(i: object): Promise<void>;
  get(k?: unknown): Promise<Record<string, unknown>>;
  remove(k: string | string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
  // the offline wrapper only
  syncNow(): Promise<void>;
  forget(o?: object): Promise<void>;
  status: string;
};

/** The token the page's store was opened with. */
export const tokenOf = (page: Page): Promise<string> =>
  page.evaluate(() => (window as unknown as { token: string }).token);

/** Run `fn` in the page with the store as its argument. */
export function withStore<T, A = undefined>(
  page: Page,
  fn: (store: Store, arg: A) => Promise<T> | T,
  arg?: A,
): Promise<T> {
  return page.evaluate(
    ([src, a]) =>
      new Function("store", "arg", `return (${src})(store, arg)`)(
        (window as unknown as { store: Store }).store,
        a,
      ),
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}

/**
 * Everything this origin keeps in the browser profile: IndexedDB contents,
 * Web Storage and Cache Storage, as JSON text.
 */
export function profileDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: Record<string, unknown> = {
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      caches: "caches" in self ? await caches.keys() : [],
      indexedDB: {},
    };
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name!);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const stores: Record<string, unknown> = {};
      for (const s of [...db.objectStoreNames]) {
        const t = db.transaction(s, "readonly").objectStore(s);
        const read = (r: IDBRequest) =>
          new Promise((res) => {
            r.onsuccess = () => res(r.result);
          });
        stores[s] = {
          keys: await read(t.getAllKeys()),
          values: await read(t.getAll()),
        };
      }
      db.close();
      (out.indexedDB as Record<string, unknown>)[name!] = stores;
    }
    return JSON.stringify(out);
  });
}

/** The real demo with an injectable backend for deterministic failure cases. */
export async function openMemoryDemo(page: Page): Promise<void> {
  await page.route("**/demo/burrow.min.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `\nwindow.demoBackend = new Burrow.MemoryBackend();
Burrow.registerBackend("demo-test", () => window.demoBackend);
window.BURROW = { backend: { type: "demo-test" } };`,
    });
  });
  await page.goto("/demo/index.html");
  await page.locator('body[data-ready="true"]').waitFor();
}

export type MemoryDemoWindow = {
  Burrow: typeof import("../../src/iife.js");
  demoBackend: import("../../src/backends/memory.js").MemoryBackend;
};
