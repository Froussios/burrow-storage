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
const LIVE = "https://firestore.googleapis.com";
/**
 * The connect-src stores and where the page may actually connect: under the
 * emulator only the emulator, so CI never writes to the live project
 * (#39, #40).
 */
const STORES = EMU ? [`http://${EMU}`] : [LIVE];

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
async function load(page: Page, scenario?: string): Promise<void> {
  await expect(async () => {
    await page.goto(
      `./?smoke=${Date.now()}${scenario ? `&scenario=${scenario}` : ""}`,
    );
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

test("the main demo selects core by default and runs under its strict CSP", async ({
  browser,
  baseURL,
}) => {
  const a = await device(browser, new URL(baseURL!).origin);
  await load(a.page);
  await expect(a.page).toHaveTitle(/^Burrow demo · /);
  await expect(a.page.locator("body")).toHaveAttribute("data-scenario", "core");
  await expect(a.page.locator("#build")).toHaveAttribute(
    "data-commit",
    COMMIT ?? /^[0-9a-f]{40}$/,
  );
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
  await expect(a.page.locator("#signin")).toBeVisible();
  await expect(a.page.locator("#draft")).toBeVisible();
  await expect(a.page.locator("#draft")).toBeDisabled();
  await expect(a.page.locator(".scenario-link")).toHaveCount(2);
  expect(a.problems).toEqual([]);
  await a.page.context().close();
});

for (const scenario of ["core", "offline"]) {
  test(`the main ${scenario} scenario reads and saves cloud data across devices`, async ({
    browser,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const a = await device(browser, origin);
    const b = await device(browser, origin);
    const note = `smoke test ${COMMIT?.slice(0, 7) ?? "local"} ${scenario} ${new Date().toISOString()}`;
    await load(a.page, scenario);
    await expect(a.page.locator("body")).toHaveAttribute(
      "data-scenario",
      scenario,
    );
    if (scenario === "offline") await a.page.locator("#remember-new").check();
    await a.page.locator("#new-token").click();
    await expect(a.page.locator("#draft")).toBeEnabled();
    await expect(a.page.locator("#code")).toHaveText(TOKEN);
    await expect(a.page.locator("#cloud-read")).toHaveAttribute(
      "data-session",
      "current",
    );
    await a.page.locator("#draft").fill(note);
    await expect(a.page.locator("#status")).toHaveText("synced", {
      timeout: 30_000,
    });
    await expect(a.page.locator("#cloud-save")).toHaveAttribute(
      "data-session",
      "current",
    );
    const token = (await a.page.locator("#code").textContent())!;
    if (scenario === "offline") {
      await load(a.page, scenario);
      await expect(a.page.locator("#draft")).toHaveValue(note);
    }
    await load(b.page, scenario);
    await b.page.locator("#token-input").fill(token);
    await b.page.locator("#token-form button[type=submit]").click();
    await expect(b.page.locator("#draft")).toHaveValue(note, {
      timeout: 30_000,
    });
    await b.page.locator("#theme").click();
    await expect(b.page.locator("#status")).toHaveText("synced", {
      timeout: 30_000,
    });
    await a.page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(a.page.locator("html")).toHaveAttribute("data-theme", "dark", {
      timeout: 30_000,
    });
    await a.page.locator("#signout").click();
    await b.page.locator("#signout").click();
    await expect(a.page.locator("#status")).toHaveText("locked");
    await expect(b.page.locator("#status")).toHaveText("locked");
    expect([...a.problems, ...b.problems]).toEqual([]);
    await a.page.context().close();
    await b.page.context().close();
  });
}

test("existing v2 links serve the promoted main demo", async ({
  browser,
  baseURL,
}) => {
  const a = await device(browser, new URL(baseURL!).origin);
  await a.page.goto(`./v2.html?scenario=offline&smoke=${Date.now()}`);
  await expect(a.page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(a.page).toHaveTitle(/^Burrow demo · /);
  await expect(a.page.locator("body")).toHaveAttribute(
    "data-scenario",
    "offline",
  );
  await expect(a.page.locator("#build")).toHaveAttribute(
    "data-commit",
    COMMIT ?? /^[0-9a-f]{40}$/,
  );
  expect(a.problems).toEqual([]);
  await a.page.context().close();
});
