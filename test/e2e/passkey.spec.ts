// KP-5..8 with Chromium's virtual authenticator (PRF): burrow-storage/passkey's
// save, a full site-data reset, restore, then link().
import { type Page, expect, test } from "@playwright/test";
import {
  type MemoryDemoWindow,
  type PasskeyBackup,
  type Store,
  openArea,
  openMemoryDemo,
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

test("KP-5 token handles replace repeat saves independent of labels and keep distinct-token backups", async ({
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

  // A renamed label still saves the same account and replaces its credential.
  await save("renamed-notes", "My laptop");
  const repeated = await credentials();
  expect(repeated).toHaveLength(1);
  expect(repeated[0]!.credentialId).not.toBe(before[0]!.credentialId);
  expect(repeated[0]!.userHandle).toBe(before[0]!.userHandle);
  expect(repeated[0]!.userName).toBe("renamed-notes");
  expect(repeated[0]!.userDisplayName).toBe("My laptop");
  expect(await withBackup(page, (b) => b.restore())).toBe(firstToken);

  // Another token with that exact label remains a distinct account.
  await withStore(page, (s) => s.unlink());
  await openArea(context, "e2e", page);
  const secondToken = await withStore(page, (s) => s.exportToken());
  expect(secondToken).not.toBe(firstToken);
  await save("renamed-notes", "My laptop");
  const both = await credentials();
  expect(both).toHaveLength(2);
  expect(new Set(both.map((c) => c.userHandle)).size).toBe(2);
  // Restore whichever the picker selects, then remove just that synthetic
  // credential to exercise the other. CDP re-import would lose PRF state.
  const asserted = new Promise<string>((resolve) =>
    cdp.once("WebAuthn.credentialAsserted", ({ credential }) =>
      resolve(credential.credentialId),
    ),
  );
  const restored = await withBackup(page, (b) => b.restore());
  const selectedId = await asserted;
  const selectedToken =
    selectedId === repeated[0]!.credentialId ? firstToken : secondToken;
  expect(both.some((c) => c.credentialId === selectedId)).toBe(true);
  expect(restored).toBe(selectedToken);
  await cdp.send("WebAuthn.removeCredential", {
    authenticatorId,
    credentialId: selectedId,
  });
  expect(await withBackup(page, (b) => b.restore())).toBe(
    selectedToken === firstToken ? secondToken : firstToken,
  );
});

test("KP-5 a failed keyslot write after same-token replacement cannot restore the earlier passkey backup", async ({
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
  await withStore(page, (s) => s.unlink({ replace: true }));
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
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText("Yes, in a passkey.");

  expect(dialogs).toEqual([]);
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

for (const failure of ["network", "cancelled"] as const) {
  test(`a first ${failure} passkey save keeps the empty demo empty for linking and Forget`, async ({
    context,
  }) => {
    const page = await context.newPage();
    const { cdp, authenticatorId } = await authenticator(page);
    await openMemoryDemo(page);
    const original = (await page.locator("#code").textContent())!;
    const dialogs: string[] = [];
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    await page.evaluate((failure) => {
      if (failure === "network")
        (window as unknown as MemoryDemoWindow).demoBackend.failWith =
          "network";
      else
        navigator.credentials.create = async () => {
          throw new DOMException("The prompt was dismissed", "NotAllowedError");
        };
    }, failure);
    await page.locator("#passkey").click();
    await expect(page.locator("#message")).toContainText(
      "Passkey backup was not saved",
    );
    await expect(page.locator("#token-backup")).toContainText("None yet");
    const credentials = (
      await cdp.send("WebAuthn.getCredentials", { authenticatorId })
    ).credentials;
    expect(credentials).toHaveLength(failure === "network" ? 1 : 0);
    const target = await page.evaluate(async () => {
      const { Burrow, demoBackend } = window as unknown as MemoryDemoWindow;
      const current = await Burrow.burrow({ app: "burrow-demo" });
      const state = {
        data: await current.get(),
        dirty: current.inspect().dirtyKeys,
      };
      demoBackend.failWith = null;
      const other = await Burrow.burrow({
        app: "first-failure-target",
        backend: demoBackend,
        cache: "memory",
      });
      return { ...state, token: await other.exportToken() };
    });
    expect(target.data).toEqual({});
    expect(target.dirty).toBe(0);
    await expect(page.locator("#code")).toHaveText(original);
    await page.locator("#link-code").fill(target.token);
    await page.locator("#link-form button[type=submit]").click();
    await expect(page.locator("#code")).toHaveText(target.token);
    await expect(page.locator("#message")).toHaveText(
      "Linked. Your data is here.",
    );
    const reloaded = page.waitForEvent("load");
    await page.locator("#forget").click();
    await reloaded;
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("#code")).not.toHaveText(target.token);
    expect(dialogs).toEqual([]);
  });
}

test("the demo clears a successful backup claim after a failed re-save and can retry", async ({
  context,
}) => {
  const page = await context.newPage();
  const { cdp, authenticatorId } = await authenticator(page);
  await openMemoryDemo(page);
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.locator("#draft").fill("keep this token");
  await expect(page.locator("#status")).toHaveText("synced");
  const token = await page.locator("#code").textContent();
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText("Yes, in a passkey.");
  const before = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials;
  expect(before).toHaveLength(1);

  await page.evaluate(() => {
    (window as unknown as MemoryDemoWindow).demoBackend.failWith = "network";
  });
  await page.locator("#passkey").click();
  await expect(page.locator("#message")).toHaveText(
    "Passkey backup was not saved (network). Keep the storage token or try again.",
  );
  await expect(page.locator("#token-backup")).toHaveText(
    "Not confirmed. Keep the storage token or try saving again.",
  );
  const after = (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
    .credentials;
  expect(after).toHaveLength(1);
  expect(after[0]!.credentialId).not.toBe(before[0]!.credentialId);
  expect(
    await page.evaluate(async () => {
      const { Burrow } = window as unknown as MemoryDemoWindow;
      return (await Burrow.burrow({ app: "burrow-demo" })).storage.getItem(
        "backup",
      );
    }),
  ).toBe("unknown");
  await expect(page.locator("#code")).toHaveText(token!);

  await page.evaluate(() => {
    (window as unknown as MemoryDemoWindow).demoBackend.failWith = null;
  });
  await page.locator("#link-passkey").click();
  await expect(page.locator("#message")).toHaveText(
    "No passkey backup was used.",
  );
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText("Yes, in a passkey.");
  await page.locator("#link-passkey").click();
  await expect(page.locator("#message")).toHaveText(
    "Linked. Your data is here.",
  );
  await expect(page.locator("#code")).toHaveText(token!);
  expect(dialogs).toEqual([]);
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

test("the demo persists uncertainty before a pending re-save and keeps it after reload", async ({
  context,
}) => {
  const page = await context.newPage();
  const { cdp, authenticatorId } = await authenticator(page);
  await openMemoryDemo(page);
  await page.locator("#passkey").click();
  await expect(page.locator("#token-backup")).toHaveText("Yes, in a passkey.");
  const before = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials;
  await page.evaluate(() => {
    // Leave the new keyslot write unresolved after the authenticator replaces
    // the old credential, reproducing a tab closed during the save.
    (window as unknown as MemoryDemoWindow).demoBackend.put = () =>
      new Promise<void>(() => {});
  });
  await page.locator("#passkey").click();
  await expect
    .poll(async () => {
      const current = (
        await cdp.send("WebAuthn.getCredentials", { authenticatorId })
      ).credentials;
      return current[0]?.credentialId;
    })
    .not.toBe(before[0]!.credentialId);
  await expect(page.locator("#forget")).toBeDisabled();
  await expect(page.locator("#link-passkey")).toBeDisabled();
  await expect(page.locator("#token-backup")).toHaveText(
    "Not confirmed. Keep the storage token or try saving again.",
  );
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#token-backup")).toHaveText(
    "Not confirmed. Keep the storage token or try saving again.",
  );
});

test("the demo reuses one restored token for unsynced-data and replacement confirmations", async ({
  context,
}) => {
  const page = await context.newPage();
  const { cdp } = await authenticator(page);
  await openMemoryDemo(page);
  const target = await page.evaluate(async () => {
    const { Burrow, demoBackend } = window as unknown as MemoryDemoWindow;
    await (await Burrow.burrow({ app: "burrow-demo" })).syncNow();
    const other = await Burrow.burrow({
      app: "passkey-link-target",
      backend: demoBackend,
      cache: "memory",
    });
    const token = await other.exportToken();
    await Burrow.passkeyBackup({ backend: demoBackend }).save(token);
    demoBackend.put = async () => {
      throw new Burrow.BackendError("network");
    };
    return token;
  });
  await page.locator("#draft").fill("not synced");
  await expect(page.locator("#status")).toHaveText("offline");
  let assertions = 0;
  cdp.on("WebAuthn.credentialAsserted", () => assertions++);
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.accept();
  });
  await page.locator("#link-passkey").click();
  await expect(page.locator("#code")).toHaveText(target);
  await expect(page.locator("#message")).toHaveText(
    "Linked. Your data is here.",
  );
  await expect(page.locator("#draft")).toHaveValue("");
  expect(assertions).toBe(1);
  expect(dialogs).toHaveLength(2);
  expect(dialogs[0]).toContain("changes that are not synced yet");
  expect(dialogs[1]).toContain("Replace this device's storage token and data?");
});
