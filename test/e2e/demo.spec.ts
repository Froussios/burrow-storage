// M7 + docs/user-journeys.md: the demo under its strict CSP, with no console
// errors. It always shows the storage token in use and where it came from, and
// syncs a second device.
import { type ConsoleMessage, type Page, expect, test } from "@playwright/test";
import { type MemoryDemoWindow, openMemoryDemo } from "./helpers.js";

const TOKEN = /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/;

// WebKit reports "Fetch API cannot load …/Listen/channel… due to access control
// checks" when a reload or a re-subscribe (after link()) cancels the Firestore
// SDK's long-poll listen request. The cancellation is intended and the SDK
// reconnects. Playwright turns this WebKit message into a pageerror, so both
// channels are filtered. A real CSP violation reads "Refused to connect".
const cancelledListen = (text: string) =>
  /\/google\.firestore\.v1\.Firestore\/Listen\/channel\b.*due to access control checks/.test(
    text,
  );

test("the demo shows the token and its source, runs under its strict CSP, and syncs a second device", async ({
  browser,
}) => {
  const errors: string[] = [];
  const keep = (text: string) => {
    if (!cancelledListen(text)) errors.push(text);
  };
  const watch = (p: Page) => {
    p.on("console", (m: ConsoleMessage) => {
      if (m.type() === "error") keep(m.text());
    });
    p.on("pageerror", (e) => keep(String(e)));
    // These tests run under the emulator; the page must never reach the live
    // project (#39). Only the origin is recorded: URLs carry document ids.
    p.on("request", (r) => {
      const origin = new URL(r.url()).origin;
      if (origin === "https://firestore.googleapis.com")
        keep(`request to ${origin}`);
    });
  };
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();

  // Journey 5 groundwork: a first visit generates a token and shows it at once.
  const a = await deviceA.newPage();
  watch(a);
  await a.goto("/demo/index.html");
  await expect(a.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(a.locator("#code")).toHaveText(TOKEN);
  await expect(a.locator("#token-source")).toContainText(
    "Generated on this device (new)",
  );
  await expect(a.locator("#token-backup")).toContainText("None yet");
  await a.locator("#theme").click();
  await expect(a.locator("html")).toHaveAttribute("data-theme", "dark");
  await a.locator("#draft").fill("hello from the demo");
  await expect(a.locator("#status")).toHaveText("synced", { timeout: 15_000 });
  const token = (await a.locator("#code").textContent())!;

  // Journey 3: another device enters the token and sees the data.
  const b = await deviceB.newPage();
  watch(b);
  await b.goto("/demo/index.html");
  await expect(b.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(b.locator("#code")).not.toHaveText(token);
  await b.locator("#link-code").fill(token.toLowerCase());
  await b.locator("#link-form button[type=submit]").click();
  await expect(b.locator("#draft")).toHaveValue("hello from the demo", {
    timeout: 30_000,
  });
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(b.locator("#code")).toHaveText(token);
  await expect(b.locator("#token-source")).toContainText("Pasted or typed in");

  // Journey 5: on the next visit the data is there immediately, and the token
  // was remembered.
  await b.reload();
  await expect(b.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(b.locator("#draft")).toHaveValue("hello from the demo");
  await expect(b.locator("#token-source")).toContainText(
    "Remembered by this browser; originally pasted or typed in",
  );

  // A URL carrying the token does not link a device (D-41): the page keeps its
  // own new token and the user has to enter the token to reach the data.
  const deviceC = await browser.newContext();
  const c = await deviceC.newPage();
  watch(c);
  await c.goto(`/demo/index.html#burrow=${token}`);
  await expect(c.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(c.locator("#code")).not.toHaveText(token);
  await expect(c.locator("#token-source")).toContainText(
    "Generated on this device (new)",
  );
  await expect(c.locator("#draft")).toHaveValue("");

  expect(errors).toEqual([]);
  await deviceA.close();
  await deviceB.close();
  await deviceC.close();
});

test("API-8 forgetting the device starts a new token on reload, and the old token still links", async ({
  page,
}) => {
  await page.goto("/demo/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#draft").fill("kept in the backup");
  await expect(page.locator("#status")).toHaveText("synced", {
    timeout: 15_000,
  });
  const before = (await page.locator("#code").textContent())!;
  page.on("dialog", (d) => void d.accept());
  const reloaded = page.waitForEvent("load");
  await page.locator("#forget").click();
  await reloaded;
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#code")).toHaveText(TOKEN);
  await expect(page.locator("#code")).not.toHaveText(before);
  await expect(page.locator("#token-source")).toContainText(
    "Generated on this device (new)",
  );
  await expect(page.locator("#draft")).toHaveValue("");
  await page.locator("#link-code").fill(before);
  await page.locator("#link-form button[type=submit]").click();
  await expect(page.locator("#draft")).toHaveValue("kept in the backup", {
    timeout: 30_000,
  });
});

test("journey 4: an invalid token shows an error and keeps the current token", async ({
  page,
}) => {
  await page.goto("/demo/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const before = await page.locator("#code").textContent();
  await page.locator("#link-code").fill("NOT-A-REAL-TOKEN");
  await page.locator("#link-form button[type=submit]").click();
  await expect(page.locator("#message")).toHaveText(
    "That token is not right. Check it and try again.",
  );
  await expect(page.locator("#code")).toHaveText(before!);
  await expect(page.locator("#token-source")).toContainText(
    "Generated on this device",
  );
});

test("the demo confirms populated token changes, while empty and same-token changes need no dialog", async ({
  page,
}) => {
  await openMemoryDemo(page);
  const first = (await page.locator("#code").textContent())!;
  const target = await page.evaluate(async () => {
    const { Burrow, demoBackend } = window as unknown as MemoryDemoWindow;
    const other = await Burrow.createBurrow(
      {
        app: "burrow-demo",
        backend: demoBackend,
        rememberDevice: false,
      },
      Burrow.browserEnv("demo-link-target"),
    );
    await other.set({ draft: "another backup" });
    await other.syncNow();
    return other.exportToken();
  });
  const dialogs: string[] = [];
  const answers: boolean[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    if (answers.shift()) await d.accept();
    else await d.dismiss();
  });
  const link = async (token: string) => {
    await page.locator("#link-code").fill(token);
    await page.locator("#link-form button[type=submit]").click();
  };

  // Empty current data can be replaced directly, then the same token relinks.
  await link(target);
  await expect(page.locator("#code")).toHaveText(target);
  await expect(page.locator("#draft")).toHaveValue("another backup");
  await link(target);
  await expect(page.locator("#message")).toHaveText(
    "Linked. Your data is here.",
  );
  expect(dialogs).toEqual([]);

  await link(first);
  await expect(page.locator("#message")).toHaveText(
    "Kept this device as it was.",
  );
  await expect(page.locator("#code")).toHaveText(target);
  await expect(page.locator("#draft")).toHaveValue("another backup");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain("Replace this device's storage token and data?");
  answers.push(true);
  await link(first);
  await expect(page.locator("#code")).toHaveText(first);
  await expect(page.locator("#draft")).toHaveValue("");
  expect(dialogs).toHaveLength(2);

  // Forgetting an empty identity needs no confirmation.
  const emptyReload = page.waitForEvent("load");
  await page.locator("#forget").click();
  await emptyReload;
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  expect(dialogs).toHaveLength(2);
  const beforeForget = (await page.locator("#code").textContent())!;
  await page.locator("#draft").fill("data worth keeping");
  await expect(page.locator("#status")).toHaveText("synced");
  await page.locator("#forget").click();
  await expect(page.locator("#message")).toHaveText(
    "Kept this device as it was.",
  );
  await expect(page.locator("#code")).toHaveText(beforeForget);
  await expect(page.locator("#draft")).toHaveValue("data worth keeping");
  expect(dialogs).toHaveLength(3);
  expect(dialogs[2]).toContain("Forget this device's storage token and data?");
  answers.push(true);
  const populatedReload = page.waitForEvent("load");
  await page.locator("#forget").click();
  await populatedReload;
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#code")).not.toHaveText(beforeForget);
  expect(dialogs).toHaveLength(4);
});

for (const action of ["link", "forget"] as const) {
  test(`the demo requires separate unsynced-data and replacement consent to ${action}`, async ({
    page,
  }) => {
    await openMemoryDemo(page);
    const original = (await page.locator("#code").textContent())!;
    const target = await page.evaluate(async () => {
      const { Burrow, demoBackend } = window as unknown as MemoryDemoWindow;
      await (await Burrow.burrow({ app: "burrow-demo" })).syncNow();
      const other = await Burrow.burrow({
        app: "demo-offline-target",
        backend: demoBackend,
        cache: "memory",
      });
      const token = await other.exportToken();
      // Reads still work, including loading the destination after consent.
      demoBackend.put = async () => {
        throw new Burrow.BackendError("network");
      };
      return token;
    });
    await page.locator("#draft").fill("not synced");
    await expect(page.locator("#status")).toHaveText("offline");
    await page.locator("#link-code").fill(target);
    const messages: string[] = [];
    const answers: boolean[] = [];
    page.on("dialog", async (d) => {
      messages.push(d.message());
      if (answers.shift()) await d.accept();
      else await d.dismiss();
    });
    const change = () =>
      page
        .locator(
          action === "link" ? "#link-form button[type=submit]" : "#forget",
        )
        .click();

    await change();
    await expect(page.locator("#message")).toHaveText(
      "Kept this device as it was.",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("changes that are not synced yet");
    await expect(page.locator("#code")).toHaveText(original);
    await expect(page.locator("#draft")).toHaveValue("not synced");

    answers.push(true, false);
    await change();
    await expect(page.locator("#message")).toHaveText(
      "Kept this device as it was.",
    );
    await expect.poll(() => messages.length).toBe(3);
    expect(messages[1]).toContain("changes that are not synced yet");
    expect(messages[2]).toContain("storage token and data?");
    await expect(page.locator("#code")).toHaveText(original);
    await expect(page.locator("#draft")).toHaveValue("not synced");

    answers.push(true, true);
    const reloaded = action === "forget" ? page.waitForEvent("load") : null;
    await change();
    if (reloaded) await reloaded;
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("#code")).not.toHaveText(original);
    await expect(page.locator("#draft")).toHaveValue("");
    expect(messages).toHaveLength(5);
    expect(messages[3]).toContain("changes that are not synced yet");
    expect(messages[4]).toContain("storage token and data?");
    if (action === "link")
      await expect(page.locator("#code")).toHaveText(target);
  });
}
