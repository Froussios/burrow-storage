// KP-5..8 with Chromium's virtual authenticator (PRF): burrow-storage/passkey's
// save, a full site-data reset, restore, then link().
import { type Page, expect, test } from "@playwright/test";
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

async function authenticator(page: Page) {
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
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { cdp, authenticatorId };
}

/** Run `fn` in the page with `Burrow.passkeyBackup()` and the area. */
function withBackup<T>(
  page: Page,
  fn: (backup: PasskeyBackup, store: Store) => Promise<T>,
  options: { userName?: string; displayName?: string } = {},
): Promise<T> {
  return page.evaluate(
    ([src, opts]) =>
      new Function(
        "w",
        "opts",
        `return (${src})(w.Burrow.passkeyBackup(opts), w.store)`,
      )(window, opts),
    [fn.toString(), options] as const,
  ) as Promise<T>;
}

test("passkey: save, wipe all site data, restore the same data with one passkey prompt", async ({
  context,
}) => {
  const page = await context.newPage();
  const { cdp } = await authenticator(page);
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

test("D-47 repeat saves replace the same-label virtual credential; another label keeps both backups", async ({
  context,
}) => {
  const page = await context.newPage();
  const { cdp, authenticatorId } = await authenticator(page);
  await openArea(context, "e2e", page);
  const credentials = async () =>
    (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
      .credentials;
  const save = (userName: string, displayName?: string) =>
    withBackup(page, async (b, s) => b.save(await s.exportToken()), {
      userName,
      displayName,
    });
  const firstToken = await withStore(page, (s) => s.exportToken());
  await save("notes");
  const before = await credentials();
  expect(before).toHaveLength(1);

  // The same handle replaces the old credential, rather than reusing its
  // PRF. Changing the display name affects only the new credential's label.
  await withStore(page, (s) => s.unlink());
  await openArea(context, "e2e", page);
  const secondToken = await withStore(page, (s) => s.exportToken());
  expect(secondToken).not.toBe(firstToken);
  await save("notes", "My laptop");
  const after = await credentials();
  expect(after).toHaveLength(1);
  expect(after[0]!.credentialId).not.toBe(before[0]!.credentialId);
  expect(after[0]!.userHandle).toBe(before[0]!.userHandle);
  expect(await withBackup(page, (b) => b.restore())).toBe(secondToken);

  // Distinct labels opt into separate entries even on the same authenticator.
  await withStore(page, (s) => s.unlink());
  await openArea(context, "e2e", page);
  const thirdToken = await withStore(page, (s) => s.exportToken());
  expect(thirdToken).not.toBe(secondToken);
  await save("notes-second");
  const both = await credentials();
  expect(both).toHaveLength(2);
  expect(new Set(both.map((c) => c.userHandle)).size).toBe(2);
  // Restore the picker-selected credential, then remove only that synthetic
  // credential to exercise the other. CDP export/re-import omits PRF state.
  const asserted = new Promise<string>((resolve) =>
    cdp.once("WebAuthn.credentialAsserted", ({ credential }) =>
      resolve(credential.credentialId),
    ),
  );
  const restored = await withBackup(page, (b) => b.restore());
  const selectedId = await asserted;
  const selectedToken =
    selectedId === after[0]!.credentialId ? secondToken : thirdToken;
  expect(both.some((c) => c.credentialId === selectedId)).toBe(true);
  expect(restored).toBe(selectedToken);
  await cdp.send("WebAuthn.removeCredential", {
    authenticatorId,
    credentialId: selectedId,
  });
  expect(await withBackup(page, (b) => b.restore())).toBe(
    selectedToken === secondToken ? thirdToken : secondToken,
  );
});

test("D-47 a failed keyslot write after same-token replacement cannot restore the earlier passkey backup", async ({
  context,
}) => {
  const page = await context.newPage();
  const { cdp, authenticatorId } = await authenticator(page);
  await openArea(context, "e2e", page);
  const token = await withStore(page, (s) => s.exportToken());
  await withBackup(page, async (b, s) => b.save(await s.exportToken()), {
    userName: "notes",
  });
  const before = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials;
  expect(before).toHaveLength(1);
  expect(await withBackup(page, (b) => b.restore())).toBe(token);

  const error = await page.evaluate(async () => {
    const w = window as unknown as {
      Burrow: {
        MemoryBackend: new () => { failWith: string };
        passkeyBackup(options: object): PasskeyBackup;
      };
      store: Store;
    };
    const backend = new w.Burrow.MemoryBackend();
    backend.failWith = "network";
    return w.Burrow.passkeyBackup({ backend, userName: "notes" })
      .save(await w.store.exportToken())
      .then(
        () => "ok",
        (e: { code: string }) => e.code,
      );
  });
  expect(error).toBe("network");
  const after = (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
    .credentials;
  expect(after).toHaveLength(1);
  expect(after[0]!.credentialId).not.toBe(before[0]!.credentialId);
  // The old encrypted keyslot remains in the store; the surviving credential
  // derives a different slot id, where no successful write ever happened.
  expect(await withBackup(page, (b) => b.restore())).toBeNull();
  expect(await withStore(page, (s) => s.exportToken())).toBe(token);
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
  const { cdp } = await authenticator(page);
  await page.goto("/demo/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#draft").fill("kept in a passkey backup");
  await expect(page.locator("#status")).toHaveText("synced", {
    timeout: 15_000,
  });
  const token = await page.locator("#code").textContent();
  page.once("dialog", (d) => void d.accept());
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText(
    "Previously saved with a passkey. Keep the storage token.",
  );

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

test("D-47 declining the demo replacement warning keeps the existing credential and backup", async ({
  context,
}) => {
  const page = await context.newPage();
  const { cdp, authenticatorId } = await authenticator(page);
  await page.goto("/demo/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const token = await page.locator("#code").textContent();
  page.once("dialog", (d) => void d.accept());
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText(
    "Previously saved with a passkey. Keep the storage token.",
  );
  const before = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials;
  expect(before).toHaveLength(1);
  expect(before[0]!.userName).toBe("burrow-demo");

  let message = "";
  page.once("dialog", async (d) => {
    message = d.message();
    await d.dismiss();
  });
  await page.locator("#passkey").click();
  await expect(page.locator("#message")).toHaveText(
    "No passkey backup was created.",
  );
  expect(message).toContain("may replace an existing passkey");
  expect(message).toContain("even if saving this backup fails");
  const after = (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
    .credentials;
  expect(after.map((c) => c.credentialId)).toEqual(
    before.map((c) => c.credentialId),
  );
  await page.locator("#link-passkey").click();
  await expect(page.locator("#message")).toHaveText(
    "Linked. Your data is here.",
  );
  await expect(page.locator("#code")).toHaveText(token!);
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
