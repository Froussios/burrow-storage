// The demo page, whatever backend it is configured with (#24, D-40, D-41).
// pages.yml runs this against the deployed demo after every deploy from main;
// ci.yml runs it against the assembled site/. The backend has its own checks:
// firestore.spec.ts.
import { expect, test } from "@playwright/test";
import { COMMIT, TOKEN, csp, device, load } from "./support";

test("the page is this build, runs under its strict CSP, connects only to its origin and its CSP's connect-src, and shows a token", async ({
  browser,
  baseURL,
}) => {
  const a = await device(browser);
  await load(a.page);
  await expect(a.page.locator("#build")).toHaveAttribute(
    "data-commit",
    COMMIT ?? /^[0-9a-f]{40}$/,
  );
  await expect(a.page.locator("#build a")).toHaveText(/^[0-9a-f]{7}$/);

  const policy = await csp(a.page);
  expect(Object.values(policy).join(" ")).not.toMatch(/'unsafe-|\*/);
  expect(policy).toMatchObject({
    "default-src": "'none'",
    "script-src": "'self'",
    "style-src": "'self'",
  });
  const [self, ...backends] = (policy["connect-src"] ?? "").split(" ");
  expect(self).toBe("'self'");
  const allowed = [new URL(baseURL!).origin, ...backends];
  expect([...a.origins].filter((o) => !allowed.includes(o))).toEqual([]);

  await expect(a.page.locator("#code")).toHaveText(TOKEN);
  await expect(a.page.locator("#token-source")).toContainText(
    "Generated on this device (new)",
  );
  expect(a.problems).toEqual([]);
});
