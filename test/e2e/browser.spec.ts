// Browser integration (all engines): persistence, second device, tabs, unload
// flush, offline.
import { expect, test } from "@playwright/test";
import { EMU, openArea, withStore } from "./helpers.js";

test("KP-1/KP-2 data and secret persist across reloads; burrow() is fast when warm", async ({
  context,
}) => {
  const page = await openArea(context);
  await withStore(page, (s) => s.set({ theme: "dark" }));
  const code = await withStore(page, (s) => s.exportToken());
  await page.reload();
  const t = await page.evaluate(async () => {
    const w = window as unknown as {
      Burrow: { burrow(c: object): Promise<unknown> };
      store: unknown;
    };
    const t0 = performance.now();
    w.store = await w.Burrow.burrow({ app: "e2e" });
    return performance.now() - t0;
  });
  expect(await withStore(page, (s) => s.get("theme"))).toEqual({
    theme: "dark",
  });
  expect(await withStore(page, (s) => s.exportToken())).toBe(code);
  test
    .info()
    .annotations.push({ type: "burrow() warm ms", description: t.toFixed(1) });
  expect(t).toBeLessThan(50);
});

test("a second device (another browser profile) gets the data via the sync code within 30 s", async ({
  browser,
}) => {
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const a = await openArea(deviceA);
  await withStore(a, (s) => s.set({ theme: "dark", draft: "written on A" }));
  await withStore(a, (s) => s.syncNow());
  const code = await withStore(a, (s) => s.exportToken());
  const b = await openArea(deviceB);
  const t0 = Date.now();
  await withStore(b, (s, code) => s.link({ token: code }), code);
  expect(await withStore(b, (s) => s.get())).toEqual({
    theme: "dark",
    draft: "written on A",
  });
  expect(Date.now() - t0).toBeLessThan(30_000);
  // And back again: B's edit reaches A through the live manifest listener.
  await withStore(b, (s) => s.set({ draft: "edited on B" }));
  await withStore(b, (s) => s.syncNow());
  await expect
    .poll(() => withStore(a, async (s) => (await s.get("draft")).draft), {
      timeout: 15_000,
    })
    .toBe("edited on B");
  await deviceA.close();
  await deviceB.close();
});

test("SYNC-14 a write in one tab shows up in another tab of the same profile", async ({
  context,
}) => {
  const t1 = await openArea(context);
  const t2 = await openArea(context);
  await withStore(t1, (s) => {
    s.storage.setItem("note", "from tab 1");
  });
  await expect
    .poll(() => withStore(t2, (s) => s.storage.getItem("note")))
    .toBe("from tab 1");
});

test("API-11 facade writes survive leaving the page immediately (pagehide flush)", async ({
  context,
}) => {
  const page = await openArea(context);
  await withStore(page, (s) => {
    s.storage.setItem("last", "words");
  });
  await page.goto("about:blank");
  await openArea(context, "e2e", page);
  expect(await withStore(page, (s) => s.storage.getItem("last"))).toBe("words");
});

test("offline: writes work locally, status goes offline, sync resumes when back online", async ({
  browser,
}) => {
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const a = await openArea(deviceA);
  const b = await openArea(deviceB);
  await withStore(
    b,
    (s, code) => s.link({ token: code }),
    await withStore(a, (s) => s.exportToken()),
  );
  await deviceA.setOffline(true);
  await withStore(a, (s) => s.set({ offlineEdit: 1 }));
  expect(await withStore(a, (s) => s.get("offlineEdit"))).toEqual({
    offlineEdit: 1,
  });
  await withStore(a, (s) => s.syncNow().catch(() => {}));
  await expect
    .poll(() => withStore(a, (s) => s.status), { timeout: 20_000 })
    .toBe("offline");
  await deviceA.setOffline(false);
  await expect
    .poll(
      async () => {
        await withStore(a, (s) => s.syncNow().catch(() => {}));
        return withStore(a, (s) => s.inspect().dirtyKeys);
      },
      { timeout: 30_000 },
    )
    .toBe(0);
  await expect
    .poll(
      async () => {
        await withStore(b, (s) => s.syncNow().catch(() => {}));
        return withStore(
          b,
          async (s) => (await s.get("offlineEdit")).offlineEdit,
        );
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  await deviceA.close();
  await deviceB.close();
});

test("KP-13 (not implemented, D-41) a #burrow=<code> fragment is ignored and stays in the URL", async ({
  browser,
}) => {
  const deviceA = await browser.newContext();
  const a = await openArea(deviceA);
  await withStore(a, (s) => s.set({ k: "shared" }));
  await withStore(a, (s) => s.syncNow());
  const code = await withStore(a, (s) => s.exportToken());
  const deviceB = await browser.newContext();
  const b = await deviceB.newPage();
  await b.goto(`/test/e2e/harness.html?emu=${EMU}#burrow=${code}`);
  await b.evaluate(async () => {
    const w = window as unknown as {
      store: unknown;
      Burrow: { burrow(c: object): Promise<unknown> };
    };
    w.store = await w.Burrow.burrow({ app: "e2e" });
  });
  expect(await withStore(b, (s) => s.exportToken())).not.toBe(code);
  expect(await withStore(b, (s) => s.get())).toEqual({});
  expect(new URL(b.url()).hash).toBe(`#burrow=${code}`);
  await deviceA.close();
  await deviceB.close();
});
