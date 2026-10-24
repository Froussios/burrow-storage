// Browser integration (all engines), under the emulator: the remote-only core
// keeps nothing in the profile; the offline wrapper keeps a plaintext copy but
// never the token, starts offline, replays queued writes and shares its copy
// between tabs (D-57).
import { expect, test } from "@playwright/test";
import {
  HEARTBEAT_DB,
  databases,
  openArea,
  profileDump,
  tokenOf,
  withStore,
} from "./helpers.js";

test("D-57 the core leaves nothing in the browser profile", async ({
  context,
}) => {
  const page = await openArea(context);
  await withStore(page, (s) => s.set({ theme: "dark", draft: "secret note" }));
  expect(await withStore(page, (s) => s.get())).toEqual({
    theme: "dark",
    draft: "secret note",
  });
  await withStore(page, (s) => s.remove("theme"));
  const token = await tokenOf(page);
  const dump = await profileDump(page);
  expect(JSON.parse(dump)).toMatchObject({
    localStorage: {},
    sessionStorage: {},
    caches: [],
  });
  expect(databases(dump)).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  // Not even the Firebase SDK's own heartbeat record holds anything of ours.
  for (const secretish of [
    token,
    token.replace(/-/g, ""),
    "secret note",
    '"draft"',
    '"theme"',
  ])
    expect(dump).not.toContain(secretish);
  expect(dump).not.toMatch(/[A-Za-z0-9_-]{40,}/); // no document ids
  expect(Object.keys(JSON.parse(dump).indexedDB)).toEqual([HEARTBEAT_DB]);
  // A reload has no way back in without the token.
  await page.reload();
  expect(databases(await profileDump(page))).toEqual([]);
});

test("a second device (another browser profile) reads the data with the same token", async ({
  browser,
}) => {
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const a = await openArea(deviceA);
  await withStore(a, (s) => s.set({ theme: "dark", draft: "written on A" }));
  const b = await openArea(deviceB, "e2e", undefined, {
    token: await tokenOf(a),
  });
  expect(await withStore(b, (s) => s.get())).toEqual({
    theme: "dark",
    draft: "written on A",
  });
  await withStore(b, (s) => s.set({ draft: "edited on B" }));
  expect(await withStore(a, (s) => s.get("draft"))).toEqual({
    draft: "edited on B",
  });
  await deviceA.close();
  await deviceB.close();
});

test("D-57 the offline copy holds plaintext items but never the token; it persists across reloads with the token supplied again", async ({
  context,
}) => {
  const page = await openArea(context, "e2e", undefined, { offline: true });
  const token = await tokenOf(page);
  await withStore(page, (s) => s.set({ theme: "dark" }));
  await withStore(page, (s) => s.syncNow());
  const dump = await profileDump(page);
  expect(dump).toContain("dark");
  for (const secretish of [token, token.replace(/-/g, "")])
    expect(dump).not.toContain(secretish);
  expect(dump).not.toMatch(/[A-Za-z0-9_-]{40,}/); // no document ids or keys
  expect(JSON.parse(dump).localStorage).toEqual({});
  expect(databases(dump)).toEqual([
    expect.stringMatching(/^burrow:e2e:[0-9a-f]{16}$/),
  ]);

  await openArea(context, "e2e", page, { token, offline: true });
  expect(await withStore(page, (s) => s.get())).toEqual({ theme: "dark" });
});

test("D-57 offline start: the wrapper opens with its token while the network is down, and replays writes when it returns", async ({
  browser,
}) => {
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const a = await openArea(deviceA, "e2e", undefined, { offline: true });
  const token = await tokenOf(a);
  await withStore(a, (s) => s.set({ before: "online" }));
  await withStore(a, (s) => s.syncNow());

  // A reload whose page comes from the network, then no network at all.
  await openArea(deviceA, "e2e", a, {
    token,
    offline: true,
    beforeOpen: () => deviceA.setOffline(true),
  });
  expect(await withStore(a, (s) => s.get())).toEqual({ before: "online" });
  await withStore(a, (s) => s.set({ offlineEdit: 1 }));
  expect(await withStore(a, (s) => s.get("offlineEdit"))).toEqual({
    offlineEdit: 1,
  });
  expect(await withStore(a, (s) => s.status)).toBe("offline");

  await deviceA.setOffline(false);
  await expect
    .poll(
      async () => {
        await withStore(a, (s) => s.syncNow().catch(() => {}));
        return withStore(a, (s) => s.status);
      },
      { timeout: 30_000 },
    )
    .toBe("idle");
  const b = await openArea(deviceB, "e2e", undefined, { token });
  expect(await withStore(b, (s) => s.get())).toEqual({
    before: "online",
    offlineEdit: 1,
  });
  await deviceA.close();
  await deviceB.close();
});

test("SYNC-14 a write in one tab shows up in another tab of the same profile", async ({
  context,
}) => {
  const t1 = await openArea(context, "e2e", undefined, { offline: true });
  const token = await tokenOf(t1);
  const t2 = await openArea(context, "e2e", undefined, {
    token,
    offline: true,
  });
  await context.setOffline(true);
  await withStore(t1, (s) => s.set({ note: "from tab 1" }));
  await expect
    .poll(() => withStore(t2, async (s) => (await s.get("note")).note))
    .toBe("from tab 1");
  await context.setOffline(false);
});

test("D-54 two apps on one origin keep separate data and local copies", async ({
  context,
}) => {
  const notes = await openArea(context, "notes", undefined, { offline: true });
  const token = await tokenOf(notes);
  const settings = await openArea(context, "settings", undefined, {
    token,
    offline: true,
  });
  await withStore(notes, (s) => s.set({ note: "n" }));
  await withStore(settings, (s) => s.set({ theme: "dark" }));
  expect(await withStore(notes, (s) => s.get())).toEqual({ note: "n" });
  expect(await withStore(settings, (s) => s.get())).toEqual({ theme: "dark" });
  expect(databases(await profileDump(notes))).toEqual([
    expect.stringMatching(/^burrow:notes:/),
    expect.stringMatching(/^burrow:settings:/),
  ]);
});

test("API-8 forget() deletes the token's local copy", async ({ context }) => {
  const page = await openArea(context, "e2e", undefined, { offline: true });
  await withStore(page, (s) => s.set({ k: 1 }));
  await withStore(page, (s) => s.forget());
  expect(databases(await profileDump(page))).toEqual([]);
});

test("D-48 an expired item pauses sync while the browser's local copy stays editable", async ({
  context,
}) => {
  const page = await openArea(context);
  const result = await page.evaluate(async () => {
    const api = (
      window as unknown as { Burrow: typeof import("../../src/iife.js") }
    ).Burrow;
    const backend = new api.MemoryBackend();
    const token = await api.generateToken();
    const open = async () =>
      api.offline(await api.burrow({ app: "expiry-browser", backend, token }));
    const area = await open();
    await area.set({ k: "cached" });
    await area.syncNow();
    // The item document is written before the manifest.
    const id = backend.store.keys().next().value!;
    const item = backend.store.get(id)!;
    backend.store.set(id, { x: true, rev: item.rev, next: item.next });
    let code: string | undefined;
    area.onStatus.addListener(({ error }) => {
      if (error) code = error.code;
    });
    const value = await area.get("k");
    let rejected: string | undefined;
    try {
      await area.syncNow();
    } catch (error) {
      rejected = (error as { code: string }).code;
    }
    await area.set({ editable: "yes" });
    const all = await area.get();
    area.close();
    const reopened = await open();
    const restored = await reopened.get();
    reopened.close();
    return { value, code, rejected, all, restored };
  });
  expect(result.value).toEqual({ k: "cached" });
  expect(result.code).toBe("expired");
  expect(result.rejected).toBe("expired");
  expect(result.all).toEqual({ k: "cached", editable: "yes" });
  expect(result.restored).toEqual(result.all);
});
