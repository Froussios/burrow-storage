// #24: the demo smoke test. pages.yml runs it against the deployed demo after
// every deploy from main, and a failure fails the run; ci.yml runs it against
// the assembled site/ under the emulator, so a failure after a deploy points at
// the deployment, not at this test. Configuration: playwright.smoke.config.ts.
import { type Browser, type Page, expect, test } from "@playwright/test";

const TOKEN = /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/;
/**
 * The commit the page must show. Set after a deploy, so a copy of an earlier
 * deploy fails.
 */
const COMMIT = process.env.BURROW_DEMO_COMMIT;
const EMU = process.env.FIRESTORE_EMULATOR_HOST;
const STORES = [
  "https://firestore.googleapis.com",
  ...(EMU ? [`http://${EMU}`] : []),
];

type Device = { page: Page; problems: string[] };

/**
 * A fresh browser context (no cache, no token), recording what a healthy page
 * never does.
 */
async function device(browser: Browser, origin: string): Promise<Device> {
  const page = await (await browser.newContext()).newPage();
  const problems: string[] = [];
  const allowed = new Set([origin, ...STORES]);
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && !allowed.has(u.origin))
      problems.push(`request to ${u.origin}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return { page, problems };
}

/**
 * Open the demo until it shows COMMIT; a new query on each attempt keeps caches
 * from serving an older page.
 */
async function load(page: Page): Promise<void> {
  await expect(async () => {
    await page.goto(`./?smoke=${Date.now()}`);
    if (COMMIT)
      await expect(page.locator("#build")).toHaveAttribute(
        "data-commit",
        COMMIT,
        { timeout: 1_000 },
      );
  }).toPass({ timeout: 180_000, intervals: [5_000, 10_000, 15_000] });
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });
}

/** The demo's debug panel: `store.inspect()`. */
const inspect = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(document.getElementById("debug")?.textContent || "null"),
  );

const directives = (csp: string) =>
  Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values.join(" ")];
      }),
  );

test("the page is this build, runs under its strict CSP, loads only from its origin and the store, and shows a token", async ({
  browser,
  baseURL,
}) => {
  const a = await device(browser, new URL(baseURL!).origin);
  await load(a.page);
  await expect(a.page.locator("#build")).toHaveAttribute(
    "data-commit",
    COMMIT ?? /^[0-9a-f]{40}$/,
  );
  await expect(a.page.locator("#build a")).toHaveText(/^[0-9a-f]{7}$/);

  const csp =
    (await a.page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content")) ?? "";
  expect(csp).not.toMatch(/'unsafe-|\*/);
  expect(directives(csp)).toMatchObject({
    "default-src": "'none'",
    "script-src": "'self'",
    "style-src": "'self'",
    "connect-src": ["'self'", ...STORES].join(" "),
  });

  await expect(a.page.locator("#code")).toHaveText(TOKEN);
  await expect(a.page.locator("#token-source")).toContainText(
    "Generated on this device (new)",
  );
  expect(a.problems).toEqual([]);
});

test("two fresh browser contexts sync through the store", async ({
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const a = await device(browser, origin);
  const b = await device(browser, origin);
  const note = `smoke test ${COMMIT?.slice(0, 7) ?? "local"} ${new Date().toISOString()}`;

  // A writes, and the write reaches the store: a new token has no manifest
  // until its first push.
  await load(a.page);
  await a.page.locator("#draft").fill(note);
  await expect
    .poll(() => inspect(a.page), { timeout: 30_000 })
    .toMatchObject({
      status: "idle",
      dirtyKeys: 0,
      manifestRev: expect.any(Number),
    });
  const token = (await a.page.locator("#code").textContent())!;

  // B links with A's token and gets the write.
  await load(b.page);
  await b.page.locator("#link-code").fill(token);
  await b.page.locator("#link-form button[type=submit]").click();
  await expect(b.page.locator("#message")).toHaveText(
    "Linked. Your data is here.",
    { timeout: 30_000 },
  );
  await expect(b.page.locator("#draft")).toHaveValue(note, { timeout: 30_000 });

  // And back: B's change reaches A, still open, through the store.
  await b.page.locator("#theme").click();
  await expect(a.page.locator("html")).toHaveAttribute("data-theme", "dark", {
    timeout: 30_000,
  });

  expect([...a.problems, ...b.problems]).toEqual([]);
});
