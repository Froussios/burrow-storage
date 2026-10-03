// KP-5..10 with Chromium's virtual authenticator (PRF): enrol, full site-data reset, recover.
import { type CDPSession, type Page, expect, test } from "@playwright/test";
import { openArea, withStore } from "./helpers.js";

test.skip(({ browserName }) => browserName !== "chromium", "virtual authenticator with PRF is Chromium-only");

async function authenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  return cdp;
}

test("passkey: enrol, wipe all site data, recover the same data with one passkey prompt", async ({ context }) => {
  const page = await context.newPage();
  const cdp = await authenticator(page);
  await openArea(context, "e2e", page);
  expect(await page.evaluate(() => (window as unknown as { Burrow: { passkey(): { available(): Promise<boolean> } } }).Burrow.passkey().available())).toBe(true);
  await withStore(page, (s) => s.set({ theme: "dark", draft: "keep me" }));
  await withStore(page, (s) => s.syncNow());
  await withStore(page, (s) => s.protect("passkey"));
  expect(await withStore(page, (s) => s.protection)).toBe("passkey");
  const code = await withStore(page, (s) => s.exportCode());

  // A full browser data reset for this site: IndexedDB, cookies, storage — everything.
  await cdp.send("Storage.clearDataForOrigin", { origin: new URL(page.url()).origin, storageTypes: "all" });
  await page.reload();
  await openArea(context, "e2e", page);
  expect(await withStore(page, (s) => s.get())).toEqual({});
  expect(await withStore(page, (s) => s.exportCode())).not.toBe(code);

  await withStore(page, (s) => s.link({ provider: "passkey" }));
  expect(await withStore(page, (s) => s.get())).toEqual({ theme: "dark", draft: "keep me" });
  expect(await withStore(page, (s) => s.exportCode())).toBe(code);
  expect(await withStore(page, (s) => s.protection)).toBe("passkey");
});

test("passkey: enrol -> unlink -> recover", async ({ context }) => {
  const page = await context.newPage();
  await authenticator(page);
  await openArea(context, "e2e", page);
  await withStore(page, (s) => s.set({ k: "v" }));
  await withStore(page, (s) => s.protect("passkey"));
  await withStore(page, (s) => s.unlink());
  await openArea(context, "e2e", page);
  expect(await withStore(page, (s) => s.get())).toEqual({});
  await withStore(page, (s) => s.link({ provider: "passkey" }));
  expect(await withStore(page, (s) => s.get())).toEqual({ k: "v" });
});

test("journeys 1 and 2 in the demo: create a backup with a passkey, wipe the site, restore it", async ({ context }) => {
  const page = await context.newPage();
  const cdp = await authenticator(page);
  await page.goto("/demo/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#draft").fill("kept in a passkey backup");
  await expect(page.locator("#status")).toHaveText("synced", { timeout: 15_000 });
  const token = await page.locator("#code").textContent();
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText("Yes, in a passkey");

  await cdp.send("Storage.clearDataForOrigin", { origin: new URL(page.url()).origin, storageTypes: "all" });
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#draft")).toHaveValue("");
  await expect(page.locator("#code")).not.toHaveText(token!);

  await page.locator("#link-passkey").click();
  await expect(page.locator("#draft")).toHaveValue("kept in a passkey backup", { timeout: 30_000 });
  await expect(page.locator("#code")).toHaveText(token!);
  await expect(page.locator("#token-source")).toContainText("Restored from your passkey");
});

test("KP-7 without a PRF authenticator the passkey provider is unavailable and protect() falls through", async ({ context }) => {
  const page = await context.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
  });
  await openArea(context, "e2e", page);
  const err = await withStore(page, (s) => s.protect("passkey").then(() => "ok", (e: { code: string }) => e.code));
  expect(["prf-unsupported", "no-provider"]).toContain(err);
  await withStore(page, (s) => s.protect()); // first available provider: the sync code
  expect(await withStore(page, (s) => s.protection)).toBe("code");
});
