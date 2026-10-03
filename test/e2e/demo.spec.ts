// M7 + docs/user-journeys.md: the demo under its strict CSP, with no console errors. It always shows
// the storage token in use and where it came from, and syncs a second device.
import { type ConsoleMessage, type Page, expect, test } from "@playwright/test";

const TOKEN = /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/;

// WebKit logs the Firestore SDK's long-poll listen request as "Fetch API cannot load …/Listen/channel…
// due to access control checks" when a reload or a re-subscribe (after link()) cancels it. The
// cancellation is intended and the SDK reconnects. A real CSP violation reads "Refused to connect".
const cancelledListen = (text: string) =>
  /\/google\.firestore\.v1\.Firestore\/Listen\/channel\b.*due to access control checks/.test(text);

test("the demo shows the token and its source, runs under its strict CSP, and syncs a second device", async ({ browser }) => {
  const errors: string[] = [];
  const watch = (p: Page) => {
    p.on("console", (m: ConsoleMessage) => { if (m.type() === "error" && !cancelledListen(m.text())) errors.push(m.text()); });
    p.on("pageerror", (e) => errors.push(String(e)));
  };
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();

  // Journey 5 groundwork: a first visit generates a token and shows it at once.
  const a = await deviceA.newPage();
  watch(a);
  await a.goto("/demo/index.html");
  await expect(a.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(a.locator("#code")).toHaveText(TOKEN);
  await expect(a.locator("#token-source")).toContainText("Generated on this device (new)");
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
  await expect(b.locator("#draft")).toHaveValue("hello from the demo", { timeout: 30_000 });
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(b.locator("#code")).toHaveText(token);
  await expect(b.locator("#token-source")).toContainText("Pasted or typed in");

  // Journey 5: on the next visit the data is there immediately, and the token was remembered.
  await b.reload();
  await expect(b.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(b.locator("#draft")).toHaveValue("hello from the demo");
  await expect(b.locator("#token-source")).toContainText("Remembered by this browser; originally pasted or typed in");

  // A link carries the token too.
  const deviceC = await browser.newContext();
  const c = await deviceC.newPage();
  watch(c);
  await c.goto(`/demo/index.html#burrow=${token}`);
  await expect(c.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(c.locator("#code")).toHaveText(token);
  await expect(c.locator("#token-source")).toContainText("Opened from a link");

  expect(errors).toEqual([]);
  await deviceA.close(); await deviceB.close(); await deviceC.close();
});

test("journey 4: an invalid token shows an error and keeps the current token", async ({ page }) => {
  await page.goto("/demo/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const before = await page.locator("#code").textContent();
  await page.locator("#link-code").fill("NOT-A-REAL-TOKEN");
  await page.locator("#link-form button[type=submit]").click();
  await expect(page.locator("#message")).toHaveText("That token is not right. Check it and try again.");
  await expect(page.locator("#code")).toHaveText(before!);
  await expect(page.locator("#token-source")).toContainText("Generated on this device");
});
