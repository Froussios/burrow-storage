// Shared by the demo smoke checks (#24, D-40, D-41): page.spec.ts checks the
// page whatever its backend; firestore.spec.ts checks the Firestore backend the
// demo is configured with. Configuration: playwright.smoke.config.ts.
import { type Browser, type Page, expect } from "@playwright/test";

export const TOKEN = /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/;
/**
 * The commit the page must show. Set after a deploy, so a copy of an earlier
 * deploy fails.
 */
export const COMMIT = process.env.BURROW_DEMO_COMMIT;

export type Device = {
  page: Page;
  /** Console errors, page errors and CSP violations. */
  problems: string[];
  /** The origin of every http(s) request the page made. */
  origins: Set<string>;
};

/**
 * A fresh browser context (no cache, no token), recording what a healthy page
 * never does and where it connects.
 */
export async function device(browser: Browser): Promise<Device> {
  const page = await (await browser.newContext()).newPage();
  const problems: string[] = [];
  const origins = new Set<string>();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol)) origins.add(u.origin);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return { page, problems, origins };
}

/**
 * Open the demo until it shows COMMIT; a new query on each attempt keeps caches
 * from serving an older page.
 */
export async function load(page: Page): Promise<void> {
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
export const inspect = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(document.getElementById("debug")?.textContent || "null"),
  );

/** The page's CSP, as directive name → its values joined by one space. */
export async function csp(page: Page): Promise<Record<string, string>> {
  const content =
    (await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content")) ?? "";
  return Object.fromEntries(
    content
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values.join(" ")];
      }),
  );
}
