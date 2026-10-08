// KP-5..8 with Chromium's virtual authenticator (PRF): burrow-storage/passkey's
// save, a full site-data reset, restore, then link().
import { type CDPSession, type Page, expect, test } from "@playwright/test";
import {
  type PasskeyBackup,
  type Store,
  openArea,
  withStore,
} from "./helpers.js";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "virtual authenticator with PRF is Chromium-only",
);

async function authenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/** Run `fn` in the page with `Burrow.passkeyBackup()` and the area. */
function withBackup<T>(
  page: Page,
  fn: (backup: PasskeyBackup, store: Store) => Promise<T>,
): Promise<T> {
  return page.evaluate(
    (src) =>
      new Function("w", `return (${src})(w.Burrow.passkeyBackup(), w.store)`)(
        window,
      ),
    fn.toString(),
  ) as Promise<T>;
}

test("passkey: save, wipe all site data, restore the same data with one passkey prompt", async ({
  context,
}) => {
  const page = await context.newPage();
  const cdp = await authenticator(page);
  await openArea(context, "e2e", page);
  expect(await withBackup(page, (b) => b.available())).toBe(true);
  await withStore(page, (s) => s.set({ theme: "dark", draft: "keep me" }));
  await withStore(page, (s) => s.syncNow());
  await withBackup(page, async (b, s) => b.save(await s.exportToken()));
  const code = await withStore(page, (s) => s.exportToken());

  // A full browser data reset for this site: IndexedDB, cookies, storage —
  // everything.
  await cdp.send("Storage.clearDataForOrigin", {
    origin: new URL(page.url()).origin,
    storageTypes: "all",
  });
  await page.reload();
  await openArea(context, "e2e", page);
  expect(await withStore(page, (s) => s.get())).toEqual({});
  expect(await withStore(page, (s) => s.exportToken())).not.toBe(code);

  const restored = await withBackup(page, (b) => b.restore());
  expect(restored).toBe(code);
  await withStore(
    page,
    (s, token) => s.link({ token, source: "passkey" }),
    restored,
  );
  expect(await withStore(page, (s) => s.get())).toEqual({
    theme: "dark",
    draft: "keep me",
  });
  expect(await withStore(page, (s) => s.exportToken())).toBe(code);
  expect(await withStore(page, (s) => s.token.source)).toBe("passkey");
});

test("passkey: save -> unlink -> restore", async ({ context }) => {
  const page = await context.newPage();
  await authenticator(page);
  await openArea(context, "e2e", page);
  await withStore(page, (s) => s.set({ k: "v" }));
  await withBackup(page, async (b, s) => b.save(await s.exportToken()));
  await withStore(page, (s) => s.unlink());
  await openArea(context, "e2e", page);
  expect(await withStore(page, (s) => s.get())).toEqual({});
  await withBackup(page, async (b, s) =>
    s.link({ token: (await b.restore())!, source: "passkey" }),
  );
  expect(await withStore(page, (s) => s.get())).toEqual({ k: "v" });
});

test("journeys 1 and 2 in the demo: create a backup with a passkey, wipe the site, restore it", async ({
  context,
}) => {
  const page = await context.newPage();
  const cdp = await authenticator(page);
  await page.goto("/demo/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#draft").fill("kept in a passkey backup");
  await expect(page.locator("#status")).toHaveText("synced", {
    timeout: 15_000,
  });
  const token = await page.locator("#code").textContent();
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText("Yes, in a passkey");

  await cdp.send("Storage.clearDataForOrigin", {
    origin: new URL(page.url()).origin,
    storageTypes: "all",
  });
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#draft")).toHaveValue("");
  await expect(page.locator("#code")).not.toHaveText(token!);

  await page.locator("#link-passkey").click();
  await expect(page.locator("#draft")).toHaveValue("kept in a passkey backup", {
    timeout: 30_000,
  });
  await expect(page.locator("#code")).toHaveText(token!);
  await expect(page.locator("#token-source")).toContainText(
    "Restored from your passkey",
  );
});

test("KP-7 without a PRF authenticator the passkey backup is unavailable and save() rejects prf-unsupported", async ({
  context,
}) => {
  const page = await context.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: false,
      automaticPresenceSimulation: true,
    },
  });
  await openArea(context, "e2e", page);
  expect(await withBackup(page, (b) => b.available())).toBe(false);
  const err = await withBackup(page, async (b, s) =>
    b.save(await s.exportToken()).then(
      () => "ok",
      (e: { code: string }) => e.code,
    ),
  );
  expect(err).toBe("prf-unsupported");
});
