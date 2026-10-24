// D-58 with Chromium's virtual authenticator (PRF): burrow-storage/passkey
// derives the token from the passkey and stores nothing; the demo's sign-in
// uses it (docs/user-journeys.md, journeys 1 and 2).
import { type Page, expect, test } from "@playwright/test";
import { databases, openArea, profileDump, withStore } from "./helpers.js";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "virtual authenticator with PRF is Chromium-only",
);

async function authenticator(
  page: Page,
  options: { hasPrf?: boolean; isUserVerified?: boolean } = {},
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: options.isUserVerified ?? true,
        hasPrf: options.hasPrf ?? true,
        automaticPresenceSimulation: true,
      },
    },
  );
  const credentials = async () =>
    (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
      .credentials;
  return { cdp, authenticatorId, credentials };
}

/** Run `call` on `Burrow.passkeyToken({ app })` in the page. */
function passkey(
  page: Page,
  call: "available" | "create" | "get",
  app = "e2e",
): Promise<{ ok: unknown } | { code: string }> {
  return page.evaluate(
    async ([call, app]) => {
      const w = window as unknown as {
        Burrow: typeof import("../../src/iife.js");
      };
      try {
        return { ok: await w.Burrow.passkeyToken({ app })[call]() };
      } catch (e) {
        return {
          code:
            (e as { code?: string; name: string }).code ?? (e as Error).name,
        };
      }
    },
    [call, app] as const,
  );
}

const tokenFrom = (r: { ok: unknown } | { code: string }) => {
  if (!("ok" in r)) throw new Error(`passkey call failed: ${r.code}`);
  return r.ok as string;
};

test("D-58 create() gives a token; after wiping all site data, get() gives it back with one prompt and the data follows", async ({
  context,
}) => {
  const page = await openArea(context);
  const { cdp, credentials } = await authenticator(page);
  expect(await passkey(page, "available")).toEqual({ ok: true });
  const token = tokenFrom(await passkey(page, "create"));
  expect(await credentials()).toHaveLength(1);
  await openArea(context, "e2e", page, { token });
  await withStore(page, (s) => s.set({ theme: "dark", draft: "keep me" }));

  // Nothing about the passkey or the token is kept by the page.
  const dump = await profileDump(page);
  expect(databases(dump)).toEqual([]);
  expect(dump).not.toContain(token);

  // A full browser data reset for this site: IndexedDB, cookies, storage.
  await cdp.send("Storage.clearDataForOrigin", {
    origin: new URL(page.url()).origin,
    storageTypes: "all",
  });
  await page.reload();
  let asserted = 0;
  cdp.on("WebAuthn.credentialAsserted", () => asserted++);
  const again = tokenFrom(await passkey(page, "get"));
  expect(again).toBe(token);
  expect(asserted).toBe(1);
  await openArea(context, "e2e", page, { token: again });
  expect(await withStore(page, (s) => s.get())).toEqual({
    theme: "dark",
    draft: "keep me",
  });
});

test("D-58 one passkey gives each app its own token; another create() adds a passkey and never replaces one", async ({
  context,
}) => {
  const page = await openArea(context);
  const { credentials } = await authenticator(page);
  const notes = tokenFrom(await passkey(page, "create", "notes"));
  const settings = tokenFrom(await passkey(page, "get", "settings"));
  expect(settings).not.toBe(notes);
  expect(tokenFrom(await passkey(page, "get", "notes"))).toBe(notes);
  const second = tokenFrom(await passkey(page, "create", "notes"));
  expect(second).not.toBe(notes);
  const creds = await credentials();
  expect(creds).toHaveLength(2);
  expect(new Set(creds.map((c) => c.userHandle)).size).toBe(2);
});

test("D-58 without PRF, create() rejects prf-unsupported and get() gives no token", async ({
  context,
}) => {
  const page = await openArea(context);
  await authenticator(page, { hasPrf: false });
  expect(await passkey(page, "create")).toEqual({ code: "prf-unsupported" });
  const got = await passkey(page, "get");
  expect("ok" in got).toBe(false);
});

test("D-58 a failed user verification rejects cancelled; no passkey at all rejects cancelled", async ({
  context,
}) => {
  const page = await openArea(context);
  expect(await page.evaluate(() => "credentials" in navigator)).toBe(true);
  await authenticator(page, { isUserVerified: false });
  expect(await passkey(page, "create")).toEqual({ code: "cancelled" });
  const other = await context.newPage();
  await openArea(context, "e2e", other);
  await authenticator(other);
  expect(await passkey(other, "get")).toEqual({ code: "cancelled" });
});

test("journeys 1 and 2 in the demo: create a passkey, reload (locked), sign in with it again, also after wiping the site", async ({
  context,
}) => {
  const page = await context.newPage();
  await page.goto("/demo/index.html");
  const { cdp } = await authenticator(page);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#signin")).toBeVisible();
  await page.locator("#passkey-create").click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#token-source")).toContainText(
    "A new passkey created here",
  );
  await expect(page.locator("#custody")).toContainText(
    "In this page's memory only",
  );
  const token = (await page.locator("#code").textContent())!;
  await page.locator("#draft").fill("behind my passkey");
  await expect(page.locator("#status")).toHaveText("synced", {
    timeout: 15_000,
  });

  // Login often: a reload locks the page; nothing was stored.
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#signin")).toBeVisible();
  expect(databases(await profileDump(page))).toEqual([]);
  await page.locator("#passkey-get").click();
  await expect(page.locator("#draft")).toHaveValue("behind my passkey", {
    timeout: 15_000,
  });
  await expect(page.locator("#code")).toHaveText(token);
  await expect(page.locator("#token-source")).toContainText("Your passkey");

  await cdp.send("Storage.clearDataForOrigin", {
    origin: new URL(page.url()).origin,
    storageTypes: "all",
  });
  await page.reload();
  await page.locator("#passkey-get").click();
  await expect(page.locator("#draft")).toHaveValue("behind my passkey", {
    timeout: 15_000,
  });
});

test("the demo says so when the passkey prompt is dismissed or PRF is missing", async ({
  context,
}) => {
  const page = await context.newPage();
  await page.goto("/demo/index.html");
  await authenticator(page, { isUserVerified: false });
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#passkey-create").click();
  await expect(page.locator("#message")).toHaveText(
    "No passkey was used. Try again, or use a storage token.",
  );
  await expect(page.locator("#signin")).toBeVisible();

  const other = await context.newPage();
  await other.goto("/demo/index.html");
  await authenticator(other, { hasPrf: false });
  await expect(other.locator("body")).toHaveAttribute("data-ready", "true");
  await other.locator("#passkey-create").click();
  await expect(other.locator("#message")).toHaveText(
    "This browser cannot use passkeys for this. Use a storage token instead.",
  );
});
