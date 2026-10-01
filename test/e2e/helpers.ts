import type { BrowserContext, Page } from "@playwright/test";

export const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "";
if (!EMU) throw new Error("run under the emulator: npm run test:e2e");

/** Open the harness page (burrow.min.js + emulator config) and an area for `app`. */
export async function openArea(context: BrowserContext, app = "e2e", page?: Page): Promise<Page> {
  const p = page ?? (await context.newPage());
  await p.goto(`/test/e2e/harness.html?emu=${EMU}`);
  await p.evaluate(async (app) => {
    const w = window as unknown as { store: unknown; Burrow: { burrow(c: object): Promise<unknown> } };
    w.store = await w.Burrow.burrow({ app, debounceMs: 50 });
  }, app);
  return p;
}

type Store = {
  set(i: object): Promise<void>; get(k?: unknown): Promise<Record<string, unknown>>; syncNow(): Promise<void>;
  exportCode(): Promise<string>; link(o: object): Promise<void>; protect(p?: string): Promise<void>; unlink(o?: object): Promise<void>;
  inspect(): Record<string, unknown>; storage: Storage; status: string; protection: string;
};

/** Run `fn` in the page with the area as its argument. */
export function withStore<T, A = undefined>(page: Page, fn: (store: Store, arg: A) => Promise<T> | T, arg?: A): Promise<T> {
  return page.evaluate(
    ([src, a]) => (new Function("store", "arg", `return (${src})(store, arg)`))((window as unknown as { store: Store }).store, a),
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}
