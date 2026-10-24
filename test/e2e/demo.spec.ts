// M7 + docs/user-journeys.md: the demo under its strict CSP, with no console
// errors, in both sign-in modes. "Every visit" holds the token in memory only;
// "stay signed in" is the page's own token record plus the offline wrapper.
import {
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  expect,
  test,
} from "@playwright/test";
import {
  type MemoryDemoWindow,
  databases,
  openMemoryDemo,
  profileDump,
} from "./helpers.js";

const TOKEN = /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/;
const KEPT = "burrow-demo:token";

// WebKit reports "Fetch API cannot load …/Listen/channel… due to access control
// checks" when a reload cancels the Firestore SDK's long-poll listen request.
// The cancellation is intended and the SDK reconnects. Playwright turns this
// WebKit message into a pageerror, so both channels are filtered. A real CSP
// violation reads "Refused to connect".
const cancelledListen = (text: string) =>
  /\/google\.firestore\.v1\.Firestore\/Listen\/channel\b.*due to access control checks/.test(
    text,
  );
// With no network the SDK's requests fail, and its WebChannel connectivity
// probe (an image on www.google.com) is refused by the page's img-src. Both
// are expected while a test holds the browser offline.
const offlineNoise = (text: string) =>
  /ERR_INTERNET_DISCONNECTED|www\.google\.com\/images\/cleardot\.gif/.test(
    text,
  );

function watch(p: Page, errors: string[]) {
  const keep = (text: string) => {
    if (!cancelledListen(text) && !offlineNoise(text)) errors.push(text);
  };
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
}

async function demo(context: BrowserContext, errors: string[], hash = "") {
  const page = await context.newPage();
  watch(page, errors);
  await page.goto(`/demo/index.html${hash}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  return page;
}

const stayingSignedIn = (page: Page) =>
  page.locator("input[name=mode][value=once]").check();

test("journeys 3 and 4 (every visit): a new token, a reload that locks, the token typed on another device, a bad token", async ({
  browser,
}) => {
  const errors: string[] = [];
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();

  // A first visit shows the sign-in choices, not a token: none is made up.
  const a = await demo(deviceA, errors);
  await expect(a.locator("#signin")).toBeVisible();
  await expect(a.locator("#app")).toBeHidden();
  await expect(a.locator("#status")).toHaveText("locked");
  await a.locator("#new-token").click();
  await expect(a.locator("#code")).toHaveText(TOKEN);
  await expect(a.locator("#token-source")).toContainText(
    "Generated on this device",
  );
  await expect(a.locator("#custody")).toContainText(
    "In this page's memory only",
  );
  await expect(a.locator("#data-copy")).toContainText(
    "Nothing is kept on this device",
  );
  await a.locator("#theme").click();
  await expect(a.locator("html")).toHaveAttribute("data-theme", "dark");
  await a.locator("#draft").fill("hello from the demo");
  await expect(a.locator("#status")).toHaveText("synced", { timeout: 15_000 });
  const token = (await a.locator("#code").textContent())!;

  // Every visit: the reload locks the page and nothing is on the device.
  await a.reload();
  await expect(a.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(a.locator("#signin")).toBeVisible();
  const dump = await profileDump(a);
  expect(databases(dump)).toEqual([]);
  expect(JSON.parse(dump).localStorage).toEqual({});
  expect(dump).not.toContain(token);

  // Journey 3: another device types the token and sees the data.
  const b = await demo(deviceB, errors);
  await b.locator("#token-input").fill(token.toLowerCase());
  await b.locator("#token-form button[type=submit]").click();
  await expect(b.locator("#draft")).toHaveValue("hello from the demo", {
    timeout: 30_000,
  });
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(b.locator("#code")).toHaveText(token);
  await expect(b.locator("#token-source")).toContainText("Pasted or typed in");

  // Journey 4: a malformed token is refused before anything opens.
  const c = await demo(deviceA, errors);
  await c.locator("#token-input").fill("not-a-token");
  await c.locator("#token-form button[type=submit]").click();
  await expect(c.locator("#message")).toHaveText(
    "That token is not right. Check it and try again.",
  );
  await expect(c.locator("#signin")).toBeVisible();

  expect(errors).toEqual([]);
  await deviceA.close();
  await deviceB.close();
});

test("D-41 a URL carrying the token signs nothing in", async ({ context }) => {
  const errors: string[] = [];
  const page = await demo(context, errors);
  await page.locator("#new-token").click();
  const token = (await page.locator("#code").textContent())!;
  const other = await demo(context, errors, `#burrow=${token}`);
  await expect(other.locator("#signin")).toBeVisible();
  expect(new URL(other.url()).hash).toBe(`#burrow=${token}`);
  expect(errors).toEqual([]);
});

test("journey 5 (stay signed in): the page keeps the token, opens at once, works offline, and signing out removes both", async ({
  browser,
}) => {
  const errors: string[] = [];
  const device = await browser.newContext();
  const other = await browser.newContext();
  const page = await demo(device, errors);
  await stayingSignedIn(page);
  await page.locator("#new-token").click();
  await expect(page.locator("#custody")).toContainText(
    "localStorage, unencrypted",
  );
  await expect(page.locator("#data-copy")).toContainText(
    "an unencrypted copy in this browser",
  );
  await page.locator("#draft").fill("stays signed in");
  await expect(page.locator("#status")).toHaveText("synced", {
    timeout: 15_000,
  });
  const token = (await page.locator("#code").textContent())!;

  // The page's own token record, and the wrapper's plaintext copy.
  const dump = JSON.parse(await profileDump(page));
  expect(JSON.parse(dump.localStorage[KEPT]).token).toBe(token);
  expect(databases(JSON.stringify(dump))).toEqual([
    expect.stringMatching(/^burrow:burrow-demo:[0-9a-f]{16}$/),
  ]);

  // The next visit opens with no prompt and the data on first render.
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#draft")).toHaveValue("stays signed in");
  await expect(page.locator("#token-source")).toContainText(
    "Kept by this page since",
  );

  // Offline: edits are kept on the device and reach the store later.
  await device.setOffline(true);
  await page.locator("#draft").fill("written offline");
  await expect(page.locator("#status")).toHaveText("offline", {
    timeout: 15_000,
  });
  await device.setOffline(false);
  await expect(page.locator("#status")).toHaveText("synced", {
    timeout: 30_000,
  });
  const b = await demo(other, errors);
  await b.locator("#token-input").fill(token);
  await b.locator("#token-form button[type=submit]").click();
  await expect(b.locator("#draft")).toHaveValue("written offline", {
    timeout: 30_000,
  });

  // Sign out removes the token record and the local copy.
  await page.locator("#signout").click();
  await expect(page.locator("#signin")).toBeVisible();
  const after = await profileDump(page);
  expect(JSON.parse(after).localStorage).toEqual({});
  expect(databases(after)).toEqual([]);
  await page.reload();
  await expect(page.locator("#signin")).toBeVisible();

  expect(errors).toEqual([]);
  await device.close();
  await other.close();
});

test("stay signed in: signing out with unsynced writes asks first, and declining keeps everything", async ({
  page,
}) => {
  await openMemoryDemo(page);
  await stayingSignedIn(page);
  await page.locator("#new-token").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as MemoryDemoWindow).demoBackend.failWith = "network";
  });
  await page.locator("#draft").fill("not in the store yet");
  await expect(page.locator("#status")).toHaveText("offline");
  page.once("dialog", (d) => void d.dismiss());
  await page.locator("#signout").click();
  await expect(page.locator("#message")).toHaveText("Still signed in.");
  await expect(page.locator("#app")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("burrow-demo:token")),
  ).not.toBeNull();
  page.once("dialog", (d) => void d.accept());
  await page.locator("#signout").click();
  await expect(page.locator("#signin")).toBeVisible();
  expect(databases(await profileDump(page))).toEqual([]);
});

test("every visit: a write the store refuses is reported, not kept", async ({
  page,
}) => {
  await openMemoryDemo(page);
  await page.locator("#new-token").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as MemoryDemoWindow).demoBackend.failWith = "network";
  });
  await page.locator("#draft").fill("lost");
  await expect(page.locator("#message")).toHaveText(
    "Not saved: the store could not be reached (backend).",
  );
  await expect(page.locator("#status")).toHaveText("offline");
});
